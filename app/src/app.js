require('dotenv').config();
// Also try loading .env from parent directory (for monorepo local dev)
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');

function ts() {
    const d = new Date();
    return `[${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}]`;
}
const path = require('path');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    extractMessageContent
} = require('@whiskeysockets/baileys');
const {
    Boom
} = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const express = require('express');
const { MenuDbService } = require('./services/menuDbService');
const StateService = require('./services/stateService');
const MenuController = require('./controllers/menuController');
const AITranslatorController = require('./controllers/aiTranslatorController');
const aiUsageService = require('./services/aiUsageService');
const orderService = require('./services/orderService');
const dashboard = require('./utils/dashboard');
const userService = require('./services/userService');
const termsService = require('./services/termsService');
const billingService = require('./services/billingService');
const configService = require('./services/configService');
const botConfigService = require('./services/botConfigService');
const emailService = require('./services/emailService');
const logService = require('./services/logService');
const logger = require('./utils/logger');
const crypto = require('crypto');
const { icon } = require('./utils/icons');
const reminderService = require('./services/reminderService');

const appRouter = express.Router();
const AUTH_SESSIONS_DIR = path.resolve(
    process.env.AUTH_SESSIONS_DIR || 
    (process.platform !== 'win32' && fs.existsSync('/data') 
        ? '/data/auth_sessions' 
        : path.join(process.cwd(), 'auth_sessions'))
);

console.log(`${ts()} [System] Auth sessions directory: ${AUTH_SESSIONS_DIR}`);

// Asegurar que la carpeta de sesiones existe desde el inicio
try {
    if (!fs.existsSync(AUTH_SESSIONS_DIR)) {
        console.log(`${ts()} [System] Creating directory: ${AUTH_SESSIONS_DIR}`);
        fs.mkdirSync(AUTH_SESSIONS_DIR, { recursive: true });
    }

    // Asegurar que la carpeta de sesiones web existe
    const WEB_SESSIONS_DIR = path.join(AUTH_SESSIONS_DIR, 'web_sessions');
    if (!fs.existsSync(WEB_SESSIONS_DIR)) {
        console.log(`${ts()} [System] Creating directory: ${WEB_SESSIONS_DIR}`);
        fs.mkdirSync(WEB_SESSIONS_DIR, { recursive: true });
    }
} catch (err) {
    console.error(`${ts()} [System] Error creating session directories: ${err.message}`);
}

// Rate limiting para login: max 5 intentos por minuto por IP
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60 * 1000;

function getLoginAttempts(ip) {
    const record = loginAttempts.get(ip);
    if (!record || Date.now() - record.start > LOGIN_WINDOW_MS) {
        loginAttempts.set(ip, { start: Date.now(), count: 0 });
        return 0;
    }
    return record.count;
}

function incrementLoginAttempts(ip) {
    const record = loginAttempts.get(ip);
    if (!record || Date.now() - record.start > LOGIN_WINDOW_MS) {
        loginAttempts.set(ip, { start: Date.now(), count: 1 });
        return 1;
    }
    record.count++;
    return record.count;
}

// Verificar token de Cloudflare Turnstile
async function verifyTurnstile(token, ip) {
    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (!secretKey) return true; // Si no está configurado, skip (solo dev)

    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', token);
    formData.append('remoteip', ip);

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: formData
    });
    const data = await result.json();
    return data.success;
}

// Ruta de Login (GET) - montada en /app
appRouter.get('/login', (req, res) => {
    let errorMsg = '';
    if (req.query.error === '1') {
        errorMsg = '<div class="error-msg">Usuario o contraseña incorrectos</div>';
    } else if (req.query.error === '2') {
        errorMsg = '<div class="error-msg">Tu cuenta está inactiva. Contacta al administrador.</div>';
    } else if (req.query.error === '3') {
        errorMsg = '<div class="error-msg">Demasiados intentos. Esperá un minuto.</div>';
    }

    let successMsg = '';
    if (req.query.reset === '1') {
        successMsg = '<div class="success-msg">Contraseña actualizada. Ingresá con tu nueva contraseña.</div>';
    }

    const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || '';
    const turnstileHtml = turnstileSiteKey
        ? `<div class="cf-turnstile" data-sitekey="${turnstileSiteKey}" data-theme="light" style="margin-bottom:20px;display:flex;justify-content:center;"></div>`
        : '';

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Login - Editor de Menú de WhatsApp</title>
            <script src="/js/robot-logo.js"></script>
            ${turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
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
                .success-msg {
                    color: #2e7d32;
                    background: #e8f5e9;
                    padding: 10px;
                    border-radius: 4px;
                    margin-bottom: 20px;
                    text-align: center;
                    font-size: 14px;
                }
                .register-link {
                    text-align: center;
                    margin-top: 20px;
                    font-size: 14px;
                    color: #666;
                }
                .register-link a {
                    color: #00bc7d;
                    cursor: pointer;
                    font-weight: 600;
                    text-decoration: none;
                }
                .register-link a:hover {
                    text-decoration: underline;
                }
                .modal-overlay {
                    display: none;
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.5);
                    z-index: 1000;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .modal-overlay.open { display: flex; }
                .modal {
                    background: white;
                    border-radius: 16px;
                    padding: 32px 28px;
                    max-width: 480px;
                    width: 100%;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.2);
                    text-align: left;
                    position: relative;
                }
                .modal h3 { font-size: 1.2rem; font-weight: 700; color: #222; margin-bottom: 4px; }
                .modal p { font-size: 0.88rem; color: #666; margin-bottom: 20px; }
                .modal-close {
                    position: absolute;
                    top: 12px; right: 16px;
                    font-size: 1.4rem;
                    cursor: pointer;
                    color: #999;
                    background: none;
                    border: none;
                }
                .modal-form label {
                    display: block;
                    font-size: 0.82rem;
                    font-weight: 600;
                    color: #444;
                    margin-bottom: 4px;
                }
                .modal-form input {
                    width: 100%;
                    padding: 10px 12px;
                    border: 1px solid #ddd;
                    border-radius: 8px;
                    font-size: 0.88rem;
                    font-family: inherit;
                    margin-bottom: 14px;
                    transition: border-color 0.2s;
                    box-sizing: border-box;
                }
                .modal-form input:focus {
                    outline: none;
                    border-color: #00bc7d;
                }
                .plan-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    padding: 12px 20px;
                    border-radius: 8px;
                    font-weight: 700;
                    font-size: 0.9rem;
                    text-decoration: none;
                    transition: all 0.2s;
                    cursor: pointer;
                    border: none;
                    font-family: inherit;
                    width: 100%;
                    text-align: center;
                }
                .plan-btn.primary { background: #0f6b4f; color: white; }
                .plan-btn.primary:hover { background: #0c5841; }
                .plan-btn:disabled { background: #ccc; cursor: default; transform: none; box-shadow: none; }
                @media (max-width: 480px) {
                    .login-box { padding: 24px 16px; margin: 10px; box-sizing: border-box; }
                    .login-box h2 { font-size: 18px; }
                }
            </style>
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com;">
        </head>
        <body>
            <div class="login-box" style="position: relative;">
                <a href="/" style="display:block;"><img src="/img/wamenu_logo_name.png" alt="WaMenu Banner" width="1408" height="768" style="width:100%;max-width:240px;height:auto;margin-bottom:10px;display:block;margin-left:auto;margin-right:auto;object-fit:contain;"></a>
                <h2>Editor de Menú de WhatsApp</h2>
                ${errorMsg}
                ${successMsg}
                <form action="/app/login" method="POST" id="loginForm">
                    <div class="form-group">
                        <label for="username">Usuario</label>
                        <input type="text" id="username" name="username" required autofocus>
                    </div>
                    <div class="form-group">
                        <label for="password">Contraseña</label>
                        <input type="password" id="password" name="password" required>
                    </div>
                    ${turnstileHtml}
                    <button type="submit" class="btn-login">Login</button>
                </form>
                <div style="text-align:center;margin-top:12px;font-size:13px;">
                    <a onclick="openResetModal()" style="color:#00bc7d;cursor:pointer;font-weight:600;text-decoration:none;">¿Olvidaste tu contraseña?</a>
                </div>
                <div class="register-link">
                    ¿No tenés usuario? <a href="/app/register">Registrate gratis 30 días</a>
                </div>
            </div>

            <!-- Modal Suscripción -->
            <div class="modal-overlay" id="modalSubscribe">
                <div class="modal">
                    <button class="modal-close" onclick="closeSubscribeModal()">${icon('xMark', 'w-4 h-4 inline')}</button>
                    <h3>Suscribite al Plan Estándar</h3>
                    <p>Completá tus datos para iniciar la suscripción mensual por <strong>$<span id="modalSubscribePrice"></span> ARS/mes</strong>.</p>
                    <p style="font-size:0.78rem;color:#999;margin-top:-12px;margin-bottom:16px;">El primer mes es gratis</p>
                    <div class="modal-form">
                        <label for="subscribeName">Nombre</label>
                        <input type="text" id="subscribeName" placeholder="Tu nombre" autocomplete="off" required>
                        <label for="subscribeEmail">Email</label>
                        <input type="email" id="subscribeEmail" placeholder="tu@email.com" autocomplete="off" required>
                        <label for="subscribeDni">DNI o CUIT</label>
                        <input type="text" id="subscribeDni" placeholder="Ej: 30123456 o 20123456789" autocomplete="off" inputmode="numeric" required>
                        <p style="font-size:0.72rem;color:#999;margin-top:-10px;margin-bottom:12px;">Necesario para emitir tu Factura C.</p>
                        <div id="subscribeError" style="color:#d32f2f;font-size:0.82rem;margin-bottom:10px;display:none;"></div>
                        <button class="plan-btn primary" id="btnSubscribeSubmit" onclick="startSubscription()">
                            Ir a MercadoPago
                        </button>
                        <p style="font-size:0.72rem;color:#aaa;margin-top:12px;">Serás redirigido a MercadoPago para completar el pago de forma segura.</p>
                    </div>
                </div>
            </div>

            <!-- Modal Recuperar Contraseña -->
            <div class="modal-overlay" id="modalReset">
                <div class="modal">
                    <button class="modal-close" onclick="closeResetModal()">${icon('xMark', 'w-4 h-4 inline')}</button>
                    <h3>Recuperar contraseña</h3>
                    <p>Ingresá el email asociado a tu cuenta y te enviaremos un link para restablecer tu contraseña.</p>
                    <div class="modal-form">
                        <label for="resetEmail">Email</label>
                        <input type="email" id="resetEmail" placeholder="tu@email.com" autocomplete="off" required>
                        <div id="resetError" style="color:#d32f2f;font-size:0.82rem;margin-bottom:10px;display:none;"></div>
                        <div id="resetSuccess" style="color:#2e7d32;font-size:0.82rem;margin-bottom:10px;display:none;"></div>
                        <button class="plan-btn primary" id="btnResetRequest" onclick="requestPasswordReset()">
                            Enviar link de recuperación
                        </button>
                    </div>
                </div>
            </div>

            <script>
                drawRobot('botLogoLogin');

                var PRECIO_ESTANDAR = '22000';
                fetch('/api/config').then(function(r) { return r.json(); }).then(function(d) {
                    if (d.precioEstandar) PRECIO_ESTANDAR = d.precioEstandar;
                }).catch(function() {});

                function openSubscribeModal() {
                    document.getElementById('modalSubscribePrice').textContent = PRECIO_ESTANDAR;
                    document.getElementById('subscribeError').style.display = 'none';
                    document.getElementById('subscribeName').value = '';
                    document.getElementById('subscribeEmail').value = '';
                    document.getElementById('btnSubscribeSubmit').disabled = false;
                    document.getElementById('btnSubscribeSubmit').textContent = 'Ir a MercadoPago';
                    document.getElementById('modalSubscribe').classList.add('open');
                }
                function closeSubscribeModal() {
                    document.getElementById('modalSubscribe').classList.remove('open');
                }

                function openResetModal() {
                    document.getElementById('resetError').style.display = 'none';
                    document.getElementById('resetSuccess').style.display = 'none';
                    document.getElementById('resetEmail').value = '';
                    document.getElementById('btnResetRequest').disabled = false;
                    document.getElementById('btnResetRequest').textContent = 'Enviar link de recuperación';
                    document.getElementById('modalReset').classList.add('open');
                }
                function closeResetModal() {
                    document.getElementById('modalReset').classList.remove('open');
                }

                async function requestPasswordReset() {
                    var email = document.getElementById('resetEmail').value.trim();
                    var errorEl = document.getElementById('resetError');
                    var successEl = document.getElementById('resetSuccess');
                    var btn = document.getElementById('btnResetRequest');

                    errorEl.style.display = 'none';
                    successEl.style.display = 'none';

                    if (!email || !/^[a-zA-Z0-9.!#$%&'*+\/=?^_{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email)) { errorEl.textContent = 'Ingresá un email válido (ej: tu@email.com)'; errorEl.style.display = 'block'; return; }

                    btn.disabled = true;
                    btn.textContent = 'Enviando...';

                    try {
                        var res = await fetch('/app/api/password-reset/request', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: email })
                        });
                        var data = await res.json();
                        successEl.textContent = data.message || 'Si el email existe, recibirás un link de recuperación.';
                        successEl.style.display = 'block';
                        btn.textContent = 'Enviado';
                    } catch(err) {
                        errorEl.textContent = 'Error de conexión';
                        errorEl.style.display = 'block';
                        btn.disabled = false;
                        btn.textContent = 'Enviar link de recuperación';
                    }
                }

                var pollTimer = null;
                var currentPreapprovalId = null;

                async function startSubscription() {
                    var name = document.getElementById('subscribeName').value.trim();
                    var email = document.getElementById('subscribeEmail').value.trim();
                    var dni = document.getElementById('subscribeDni').value.trim();
                    var errorEl = document.getElementById('subscribeError');
                    var btn = document.getElementById('btnSubscribeSubmit');

                    if (!name) { errorEl.textContent = 'Ingresá tu nombre'; errorEl.style.display = 'block'; return; }
                    if (!email || !/^[a-zA-Z0-9.!#$%&'*+\/=?^_{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email)) { errorEl.textContent = 'Ingresá un email válido (ej: tu@email.com)'; errorEl.style.display = 'block'; return; }
                    if (!dni || !/^\d{7,11}$/.test(dni.replace(/\D/g, ''))) { errorEl.textContent = 'Ingresá un DNI (7-8 dígitos) o CUIT (11 dígitos) válido'; errorEl.style.display = 'block'; return; }

                    errorEl.style.display = 'none';
                    btn.disabled = true;
                    btn.textContent = 'Creando suscripción...';

                    try {
                        var res = await fetch('/api/mercadopago/create-subscription', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: name, email: email, dni: dni })
                        });
                        var data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Error del servidor');

                        currentPreapprovalId = data.preapproval_id;
                        btn.textContent = 'Esperando pago...';

                        var mpWindow = window.open(data.init_point, '_blank', 'width=800,height=700');

                        pollTimer = setInterval(async function() {
                            try {
                                var r = await fetch('/api/mercadopago/check-status?preapproval_id=' + currentPreapprovalId);
                                var st = await r.json();
                                if (st.status === 'authorized' || st.status === 'approved') {
                                    clearInterval(pollTimer);
                                    btn.textContent = 'Pago confirmado';
                                    if (mpWindow && !mpWindow.closed) mpWindow.close();
                                    window.location.href = '/pago_exitoso?preapproval_id=' + currentPreapprovalId;
                                }
                            } catch(e) {}
                        }, 2000);
                    } catch (err) {
                        errorEl.textContent = 'Error: ' + err.message;
                        errorEl.style.display = 'block';
                        btn.disabled = false;
                        btn.textContent = 'Ir a MercadoPago';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// ─────────────────────────────────────────────────────────────
// Registro de prueba gratuita
// ─────────────────────────────────────────────────────────────

appRouter.get('/register', (req, res) => {
    let errorMsg = '';
    if (req.query.error === '1') errorMsg = '<div class="error-msg">El email ya está registrado. Intentá con otro o iniciá sesión.</div>';
    if (req.query.error === '2') errorMsg = '<div class="error-msg">Faltan campos obligatorios.</div>';
    if (req.query.error === '3') errorMsg = '<div class="error-msg">Demasiados intentos. Esperá un minuto.</div>';

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Registro — Bot Menu</title>
            <style>
                body { font-family: 'Segoe UI', sans-serif; background: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                .login-box { background: #fbfbfb; border: 1px solid #e7e3e4; padding: 40px; border-radius: 8px; width: 100%; max-width: 400px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
                .login-box h2 { margin-top: 0; color: #333; text-align: center; margin-bottom: 10px; }
                .subtitle { text-align: center; color: #666; font-size: 0.9rem; margin-bottom: 30px; }
                .trial-badge { display: inline-block; background: #00bc7d; color: white; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 700; margin-bottom: 16px; }
                .form-group { margin-bottom: 16px; }
                .form-group label { display: block; margin-bottom: 5px; color: #666; font-size: 0.9rem; }
                .form-group input { width: 100%; padding: 12px; border: 1px solid #e7e3e4; border-radius: 4px; box-sizing: border-box; font-size: 16px; }
                .btn-login { background-color: #00bc7d; color: white; border: none; padding: 12px; width: 100%; border-radius: 4px; font-size: 16px; font-weight: bold; cursor: pointer; transition: background-color 0.3s; }
                .btn-login:hover { background-color: #00a56d; }
                .error-msg { color: #d32f2f; background: #ffcdd2; padding: 10px; border-radius: 4px; margin-bottom: 20px; text-align: center; font-size: 14px; }
                .login-link { text-align: center; margin-top: 20px; font-size: 14px; color: #666; }
                .login-link a { color: #00bc7d; cursor: pointer; font-weight: 600; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="login-box">
                <div style="text-align:center;"><img src="/img/wamenu_logo_name.png" alt="WaMenu" width="1408" height="768" style="width:100%;max-width:200px;height:auto;margin-bottom:10px;object-fit:contain;"></div>
                <h2>Creá tu cuenta gratis</h2>
                <div style="text-align:center;"><span class="trial-badge">30 días gratis sin tarjeta</span></div>
                <p class="subtitle">Probá Bot Menu sin compromiso. Configurá tu menú de WhatsApp en minutos.</p>
                ${errorMsg}
                <form action="/app/register" method="POST">
                    <div class="form-group">
                        <label for="name">Nombre de tu negocio</label>
                        <input type="text" id="name" name="name" placeholder="Ej: La Esquina" required autofocus>
                    </div>
                    <div class="form-group">
                        <label for="email">Email</label>
                        <input type="email" id="email" name="email" placeholder="tu@email.com" required>
                    </div>
                    <div class="form-group">
                        <label for="password">Contraseña</label>
                        <input type="password" id="password" name="password" placeholder="Mínimo 8 caracteres, 1 letra y 1 número" required minlength="8">
                    </div>
                    <button type="submit" class="btn-login">Crear cuenta y empezar prueba</button>
                </form>
                <div class="login-link">
                    ¿Ya tenés cuenta? <a href="/app/login">Iniciá sesión</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

appRouter.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const resp = await fetch(`${req.protocol}://${req.get('host')}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });
        const data = await resp.json();
        if (data.success) {
            const userService = require('./services/userService');
            const user = await userService.getUserByUsername(data.username);
            if (user) {
                req.session.user = user;
                return res.redirect('/app/verify-email-sent');
            }
        }
        res.redirect('/app/register?error=1');
    } catch (error) {
        console.error('[Register] Error:', error);
        res.redirect('/app/register?error=1');
    }
});

// Ruta de Login (POST)
appRouter.post('/login', async (req, res) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    // Rate limiting
    if (getLoginAttempts(clientIp) >= LOGIN_MAX_ATTEMPTS) {
        return res.redirect('/app/login?error=3');
    }

    const { username, password, 'cf-turnstile-response': turnstileToken } = req.body;

    // Verificar Turnstile
    if (turnstileToken) {
        const turnstileValid = await verifyTurnstile(turnstileToken, clientIp);
        if (!turnstileValid) {
            return res.redirect('/app/login?error=1');
        }
    }

    incrementLoginAttempts(clientIp);

    try {
        const user = await userService.getUserByUsername(username);

        // 1. Verificar si el usuario existe y la contraseña coincide
        if (!user || user.password !== password) {
            logger.warn('auth', username, 'Intento de login fallido (credenciales inválidas)', { ip: clientIp });
            return res.redirect('/app/login?error=1');
        }

        // 2. Verificar si el usuario está activo
        if (!user.activo) {
            logger.warn('auth', user.idCliente, 'Intento de login de cuenta inactiva/suspendida', { ip: clientIp });
            return res.redirect('/app/login?error=2');
        }

        // Reset intentos exitosos
        loginAttempts.delete(clientIp);

        // Si todo está bien, iniciar sesión
        req.session.user = user;
        logger.info('auth', user.idCliente, 'Login exitoso', { ip: clientIp });
        logService.track({ userId: user.idCliente, action: 'login', entity: 'auth', message: 'Inicio de sesión', ip: clientIp }).catch(() => {});
        return res.redirect('/app/');
    } catch (error) {
        console.error(`${ts()} Login Error:`, error);
        res.redirect('/app/login?error=1');
    }
});

// Ruta de Logout
appRouter.get('/logout', (req, res) => {
    const uid = req.session && req.session.user ? req.session.user.idCliente : '';
    if (uid) {
        logService.track({ userId: uid, action: 'logout', entity: 'auth', message: 'Cierre de sesión' }).catch(() => {});
    }
    req.session.destroy((err) => {
        if (err) {
            console.error(`${ts()} Error destroying session:`, err);
        }
        res.clearCookie('connect.sid'); // Nombre por defecto de la cookie de session
        res.redirect('/app/login');
    });
});

// --- Unsubscribe (link in email footers) ---
appRouter.get('/unsubscribe', async (req, res) => {
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baja de emails — Bot Menu</title><style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;}.card{background:white;border-radius:12px;padding:32px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08);}.card h2{margin:0 0 12px;color:#333;}.card p{color:#666;font-size:.95rem;line-height:1.5;}.btn{display:inline-block;margin-top:20px;padding:12px 28px;background:#0f6b4f;color:white;border-radius:8px;text-decoration:none;font-weight:700;}</style></head><body><div class="card"><h2>✅ Baja confirmada</h2><p>No recibirás más correos promocionales de Bot Menu. Seguirás recibiendo notificaciones importantes relacionadas con tu cuenta.</p><a href="/" class="btn">Volver al inicio</a></div></body></html>`);
});

// --- Password Reset ---
const passwordResetTokens = new Map(); // token -> { idCliente, email, expiresAt }

appRouter.post('/api/password-reset/request', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Ingresá tu email' });

    try {
        userService.clearCache();
        const user = await userService.getUserByEmail(email);
        if (!user) {
            console.log(`${ts()} [PasswordReset] No user found for email: ${email}`);
        } else {
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = Date.now() + 15 * 60 * 1000;
            passwordResetTokens.set(token, { idCliente: user.idCliente, email: user.email, expiresAt });

            const siteUrl = process.env.SITE_URL || 'http://localhost:8000';
            const resetUrl = `${siteUrl}/app/reset-password?token=${token}`;

            console.log(`${ts()} [PasswordReset] Sending reset email to ${user.email} (${user.nombreCliente})...`);
            await emailService.sendPasswordResetEmail({
                to: user.email,
                name: user.nombreCliente,
                resetUrl
            });
            console.log(`${ts()} [PasswordReset] Email sent successfully for ${user.email}`);
        }
    } catch (err) {
        console.error(`${ts()} [PasswordReset] Error:`, err.message, err.stack);
    }

    // Siempre responder lo mismo (no revelar si el email existe)
    res.json({ success: true, message: 'Si el email existe, recibirás un link de recuperación.' });
});

appRouter.get('/reset-password', (req, res) => {
    const { token } = req.query;
    if (!token) return res.redirect('/app/login?error=1');

    const data = passwordResetTokens.get(token);
    if (!data || Date.now() > data.expiresAt) {
        passwordResetTokens.delete(token);
        return res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Link expirado</title>
            <style>body{font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff;}
            .box{text-align:center;padding:40px;max-width:400px;}.box h2{color:#333;margin-bottom:8px;}.box p{color:#666;margin-bottom:20px;}
            .box a{color:#00bc7d;text-decoration:none;font-weight:600;}</style></head>
            <body><div class="box"><h2>Link expirado</h2><p>El link de recuperación expiró o ya fue utilizado.</p><a href="/app/login">Volver al login</a></div></body></html>
        `);
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Restablecer contraseña</title>
        <style>
            body{font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff;}
            .login-box{background:#fbfbfb;border:1px solid #e7e3e4;padding:40px;border-radius:8px;width:100%;max-width:400px;box-shadow:0 4px 6px rgba(0,0,0,0.05);box-sizing:border-box;}
            .login-box h2{margin-top:0;color:#333;text-align:center;margin-bottom:30px;}
            .form-group{margin-bottom:20px;}
            .form-group label{display:block;margin-bottom:5px;color:#666;}
            .form-group input{width:100%;padding:12px;border:1px solid #e7e3e4;border-radius:4px;box-sizing:border-box;font-size:16px;}
            .btn-login{background-color:#00bc7d;color:white;border:none;padding:12px;width:100%;border-radius:4px;font-size:16px;font-weight:bold;cursor:pointer;transition:background-color 0.3s;}
            .btn-login:hover{background-color:#00a56d;}
            .error-msg{color:#d32f2f;background:#ffcdd2;padding:10px;border-radius:4px;margin-bottom:20px;text-align:center;font-size:14px;}
            .success-msg{color:#2e7d32;background:#e8f5e9;padding:10px;border-radius:4px;margin-bottom:20px;text-align:center;font-size:14px;}
            .back-link{text-align:center;margin-top:16px;font-size:14px;color:#666;}
            .back-link a{color:#00bc7d;font-weight:600;text-decoration:none;}
            .back-link a:hover{text-decoration:underline;}
        </style></head>
        <body>
            <div class="login-box">
                <h2>Restablecer contraseña</h2>
                <div id="msg"></div>
                <form onsubmit="return resetPassword(event)">
                    <div class="form-group">
                        <label for="newPassword">Nueva contraseña</label>
                        <input type="password" id="newPassword" required minlength="8">
                    </div>
                    <div class="form-group">
                        <label for="confirmPassword">Confirmar contraseña</label>
                        <input type="password" id="confirmPassword" required minlength="8">
                    </div>
                    <button type="submit" class="btn-login" id="btnReset">Guardar contraseña</button>
                </form>
                <div class="back-link"><a href="/app/login">Volver al login</a></div>
            </div>
            <script>
                async function resetPassword(e) {
                    e.preventDefault();
                    var pass = document.getElementById('newPassword').value;
                    var confirm = document.getElementById('confirmPassword').value;
                    var msg = document.getElementById('msg');
                    var btn = document.getElementById('btnReset');
                    if (pass !== confirm) {
                        msg.innerHTML = '<div class="error-msg">Las contraseñas no coinciden</div>';
                        return false;
                    }
                    btn.disabled = true;
                    btn.textContent = 'Guardando...';
                    try {
                        var res = await fetch('/app/reset-password', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ token: '${token}', password: pass })
                        });
                        var data = await res.json();
                        if (data.success) {
                            msg.innerHTML = '<div class="success-msg">Contraseña actualizada. Redirigiendo...</div>';
                            setTimeout(function() { window.location.href = '/app/login?reset=1'; }, 1500);
                        } else {
                            msg.innerHTML = '<div class="error-msg">' + (data.error || 'Error al actualizar') + '</div>';
                            btn.disabled = false;
                            btn.textContent = 'Guardar contraseña';
                        }
                    } catch(err) {
                        msg.innerHTML = '<div class="error-msg">Error de conexión</div>';
                        btn.disabled = false;
                        btn.textContent = 'Guardar contraseña';
                    }
                    return false;
                }
            </script>
        </body></html>
    `);
});

appRouter.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Datos incompletos' });
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres, incluir una letra y un número' });

    const data = passwordResetTokens.get(token);
    if (!data || Date.now() > data.expiresAt) {
        passwordResetTokens.delete(token);
        return res.status(400).json({ error: 'Link expirado o inválido' });
    }

    const ok = await userService.updatePassword(data.idCliente, password);
    passwordResetTokens.delete(token);

    if (ok) {
        console.log(`${ts()} [PasswordReset] Password updated for ${data.email}`);
        res.json({ success: true });
    } else {
        res.status(500).json({ error: 'Error al actualizar la contraseña' });
    }
});

// Página: email de verificación enviado
appRouter.get('/verify-email-sent', (req, res) => {
    const email = req.session?.user?.email || '';
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verificá tu email — Bot Menu</title>
    <style>
        body{font-family:'Segoe UI',sans-serif;background:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}
        .box{background:#fbfbfb;border:1px solid #e7e3e4;padding:40px;border-radius:8px;width:100%;max-width:420px;text-align:center;box-shadow:0 4px 6px rgba(0,0,0,0.05);}
        .box h2{color:#333;margin-top:10px;} .box p{color:#666;font-size:0.95rem;line-height:1.5;}
        .btn{display:inline-block;margin-top:20px;padding:12px 24px;background:#00bc7d;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer;}
        .btn:hover{background:#00a56d;} .btn:disabled{background:#ccc;cursor:default;}
        .link{display:block;margin-top:14px;color:#00bc7d;cursor:pointer;font-size:14px;text-decoration:none;}
        .link:hover{text-decoration:underline;}
    </style>
</head>
<body>
<div class="box">
    <div style="font-size:48px;margin-bottom:10px;">&#9993;</div>
    <h2>Verificá tu email</h2>
    <p>Te enviamos un email de verificación a <strong>${email}</strong>. Hacé clic en el enlace del email para activar tu cuenta.</p>
    <p style="font-size:0.85rem;color:#999;margin-top:12px;">No te olvides de revisar la carpeta de spam.</p>
    <button class="btn" id="btnResend" onclick="resendVerification()">Reenviar email de verificación</button>
    <a class="link" href="/app/qr">Ir al panel &#8594;</a>
</div>
<script>
var userEmail=${JSON.stringify(email)};
async function resendVerification(){
    var btn=document.getElementById('btnResend');btn.disabled=true;btn.textContent='Enviando...';
    try{var r=await fetch('/api/resend-verification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:userEmail})});
    var d=await r.json();if(d.success){btn.textContent='Email reenviado';}else{btn.textContent=d.error||'Intentá de nuevo';btn.disabled=false;}}
    catch(e){btn.textContent='Error de conexión';btn.disabled=false;}
}
</script>
</body></html>`);
});

// Middleware de Autenticación para rutas de /app
appRouter.use(async (req, res, next) => {
    if (req.path === '/login' || req.path === '/health' || req.path.startsWith('/reset-password') || req.path === '/api/password-reset/request' || req.path === '/verify-email-sent') {
        return next();
    }
    if (req.session && req.session.user) {
        req.user = req.session.user;
        if (!req.user.emailVerified) {
            const freshUser = await userService.getUserByIdCliente(req.user.idCliente);
            if (freshUser && freshUser.emailVerified) {
                req.user.emailVerified = true;
                req.session.user.emailVerified = true;
            }
        }
        if (!req.user.emailVerified && req.path !== '/logout' && req.user.idCliente !== 'admin') {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ error: 'Email not verified' });
            }
            return res.redirect('/app/verify-email-sent');
        }
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/app/login');
});

const botQRs = {}; // Object to store status and data for each bot

// Detiene la conexión de un bot (si está corriendo/conectando) y limpia el QR.
// Reutilizable por los endpoints y por el job de vencimiento de suscripción.
function stopBotConnection(id, reason = 'stopped_inactivity') {
    const data = botQRs[id];
    if (!data) return;
    if (data.status === 'connected' || data.status === 'connecting' || data.status === 'qr_ready' || data.status === 'starting') {
        console.log(`${ts()} [${id}] Stopping connection (${reason})`);
        logger.info('bot', id, `Bot detenido (${reason})`);
        if (data.sock) {
            try {
                data.sock.end();
            } catch (e) {}
        }
        data.status = reason;
        data.qr = null;
        data.rawQr = null;
        data.qrReadyTimestamp = null;
    }
}

function initializeBotEntry(client) {
    if (botQRs[client.idCliente]) return botQRs[client.idCliente];
    if (client.idCliente === 'admin') return null;

    const authFolder = path.resolve(AUTH_SESSIONS_DIR, `auth_info_${client.idCliente}`);
    const botConfig = {
        id: client.idCliente,
        spreadsheetId: client.spreadsheetId || process.env.SPREADSHEET_ID,
        credentials: process.env.CREDENTIALS_JSON,
        authFolder: authFolder
    };

    botQRs[client.idCliente] = {
        status: 'waiting_start',
        qr: null,
        rawQr: null,
        lastUpdate: new Date().toLocaleTimeString(),
        config: botConfig,
        lastActiveViewer: 0
    };
    return botQRs[client.idCliente];
}

async function startBot(botConfig, forceStart = false) {
    const {
        id,
        spreadsheetId,
        credentials,
        authFolder
    } = botConfig;

    // Si el bot ya está corriendo o conectando, no hacer nada a menos que sea forceStart
    if (botQRs[id]?.status === 'connected' || botQRs[id]?.status === 'connecting' || botQRs[id]?.status === 'qr_ready') {
        if (!forceStart) return;
    }

    console.log(`${ts()} [${id}] Starting initialization...`);
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
        // Asegurar que la carpeta base de sesiones existe antes de cada inicio
        if (!fs.existsSync(AUTH_SESSIONS_DIR)) {
            fs.mkdirSync(AUTH_SESSIONS_DIR, { recursive: true });
        }
        
        // También asegurar que la carpeta específica de este bot existe
        if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true });
        }

        const googleSheetsService = new MenuDbService({
            clientId: id
        });

        const stateService = new StateService(id);
        const menuController = new MenuController(googleSheetsService, stateService, orderService);
        const aiTranslatorController = new AITranslatorController({
            idCliente: id,
            googleSheetsService,
            stateService,
            orderService,
            menuController
        });

        // Inyectar el interceptor del asistente en el menuController: cuando el
        // menú cambia a un nodo de checkout/compra, el asistente interviene
        // (presenta natural + aplica reglas de derivación al vendedor).
        menuController.setAssistantInterceptor((sock, jid, pushName, context) => {
            return aiTranslatorController.intervenirNodoCheckout(sock, jid, pushName, context);
        });

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(authFolder);
        const {
            version
        } = await fetchLatestBaileysVersion();

        console.log(`${ts()} [${id}] Using Baileys version: ${version.join('.')}`);

        const sock = makeWASocket({
            version,
            logger: pino({
                level: 'error'
            }),
            auth: state,
            browser: ['Bot Menu', 'Chrome', '1.0.0'],
            printQRInTerminal: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            getMessage: async (key) => {
                return {
                    conversation: 'bot-menu'
                };
            }
        });

        botQRs[id].sock = sock;

        // WRAPPER DE TRADUCCIÓN: interceptamos todas las salidas del menú hacia el
        // cliente. Si el mensaje es un menú con opciones numeradas, el traductor lo
        // reformula en tono amable y sin números (solo para plan premium).
        // El flag _translated evita re-traducir (mensajes ya generados por el traductor).
        (function wrapSend(translator) {
            const originalSend = sock.sendMessage.bind(sock);
            sock.sendMessage = async function (jid, content, opts) {
                if (content && typeof content === 'object' && content.text && !content._translated) {
                    try {
                        const friendly = await translator.reformulate(content.text, jid);
                        if (friendly && friendly !== content.text) {
                            const payload = { ...content, text: friendly, _translated: true };
                            delete payload._translated;
                            return originalSend(jid, payload, opts);
                        }
                    } catch (err) {
                        console.error(`[AI] Error traduciendo salida de ${id}:`, err.message);
                    }
                }
                return originalSend(jid, content, opts);
            };
        })(aiTranslatorController);

        sock.ev.on('connection.update', async (update) => {
            const {
                connection,
                lastDisconnect,
                qr
            } = update;
            botQRs[id].lastUpdate = new Date().toLocaleTimeString();

            if (qr) {
                console.log(`${ts()} [${id}] New QR code received`);
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
                        console.error(`${ts()} [${id}] Error generating QR DataURL:`, err);
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom) ?
                    lastDisconnect.error.output.statusCode : 0;

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.connectionReplaced;

                reminderService.stopBot(id);
                console.log(`${ts()} [${id}] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                logger.warn('bot', id, `Bot desconectado (código ${statusCode})`, { statusCode, reconnecting: shouldReconnect });

                // Si fue cerrado por inactividad, timeout o suscripción suspendida, no intentar reconectar automáticamente
                if (botQRs[id].status === 'stopped_inactivity' || botQRs[id].status === 'timeout_qr' || botQRs[id].status === 'suspended_subscription') {
                    console.log(`${ts()} [${id}] Connection stopped due to inactivity/timeout/suspension. Waiting for manual start.`);
                    return;
                }

                botQRs[id].status = 'disconnected';
                botQRs[id].qr = null;
                botQRs[id].rawQr = null;
                botQRs[id].qrReadyTimestamp = null;

                if (shouldReconnect) {
                    console.log(`${ts()} [${id}] Attempting to reconnect in 5s...`);
                    setTimeout(() => startBot(botConfig), 5000);
                } else {
                    console.log(`${ts()} [${id}] Logged out or session replaced. Session deleted.`);
                    botQRs[id].status = 'logged_out';
                    
                    // Borrar carpeta de sesión si fue logout (401) o sesión reemplazada (440)
                    if (fs.existsSync(authFolder)) {
                        try {
                            fs.rmSync(authFolder, { recursive: true, force: true });
                            console.log(`${ts()} [${id}] Auth folder deleted due to logout/replaced.`);
                        } catch (err) {
                            console.error(`${ts()} [${id}] Error deleting auth folder: ${err.message}`);
                        }
                    }
                }
            } else if (connection === 'open') {
                console.log(`${ts()} [${id}] ${icon('checkCircle', 'w-4 h-4 inline text-green-400')} Connection opened successfully!`);
                logger.info('bot', id, 'Bot conectado a WhatsApp');
                botQRs[id].status = 'connected';
                botQRs[id].qr = null;
                botQRs[id].rawQr = null;
                botQRs[id].qrReadyTimestamp = null;
                reminderService.startBot(id, { sock, menuController });
            } else if (connection) {
                botQRs[id].status = connection;
                console.log(`${ts()} [${id}] Connection state: ${connection}`);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const jid = msg.key.remoteJidAlt || msg.key.remoteJid;
                        if (msg.broadcast || jid.endsWith('@broadcast')) continue;
                        // Log para diagnosticar mensajes de stories que llegan desde JID del contacto
                        if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) {
                            console.log(`${ts()} [${id}] ${icon('exclamationTriangle', 'w-4 h-4 inline text-yellow-400')} MSG inusual:`, JSON.stringify({ jid, remoteJid: msg.key.remoteJid, remoteJidAlt: msg.key.remoteJidAlt, participant: msg.key.participant, category: msg.category, broadcast: msg.broadcast, stubType: msg.messageStubType, hasMessage: !!msg.message, msgKeys: Object.keys(msg.message || {}) }));
                        }
                        const content = extractMessageContent(msg.message) || msg.message;
                        // 🚨 FILTRO: Ignorar protocolos de distribución de estados y sincronización
                        if (
                            content.protocolMessage ||
                            content.senderKeyDistributionMessage ||
                            msg.key.remoteJid === 'status@broadcast'
                        ) {
                            continue;
                        }
                        const text = msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            msg.message.buttonsResponseMessage?.selectedButtonId ||
                            msg.message.listResponseMessage?.singleSelectReply?.selectedRowId;

                        const image = content.imageMessage;
                        const document = content.documentMessage;
                        const audio = content.audioMessage || content.ptvMessage;

                        if (audio) {
                            console.log(`${ts()} [${id}] Audio from ${jid}: solo se acepta texto`);
                            try {
                                await menuController.sendPresenceTyping(sock, jid);
                                await sock.sendMessage(jid, {
                                    text: `🎤 Recibí tu nota de voz, pero por ahora solo acepto mensajes de *texto*. ` +
                                        `Escribime tu consulta o pedido por acá y te ayudo.`
                                }).catch(() => {});
                            } catch (err) {
                                console.error(`${ts()} [${id}] Error respondiendo a audio de ${jid}:`, err);
                            }
                        } else if (image || document) {
                            const media = image || document;
                            const caption = image?.caption || document?.caption || '';
                            const filename = image ? 'imagen.jpg' : (document.fileName || 'documento.pdf');
                            const waitingFile = stateService.getWaitingForFile(jid);
                            console.log(`${ts()} [${id}] Media from ${jid}: type=${image?'image':'document'}, waitingFile=${waitingFile}, caption="${caption}"`);

                            if (waitingFile) {
                                try {
                                    const buffer = await downloadMediaMessage(msg);
                                    await menuController.handleIncomingMessage(sock, jid, caption, {
                                        type: image ? 'image' : 'document',
                                        buffer,
                                        filename,
                                        mimetype: media.mimetype
                                    });
                                } catch (err) {
                                    console.error(`${ts()} [${id}] Error descargando archivo de ${jid}:`, err);
                                    await menuController.handleIncomingMessage(sock, jid, caption);
                                }
                            } else if (caption) {
                                // Media con caption: el traductor no procesa media directo,
                                // pero si el caption es lenguaje natural y el menú no está en
                                // un flujo especial, lo interpretamos. Simplificamos: el menú
                                // siempre maneja media; el caption se deja tal cual.
                                const mediaBuf2 = await downloadMediaMessage(msg).catch(() => null);
                                if (mediaBuf2) {
                                    await menuController.handleIncomingMessage(sock, jid, caption, {
                                        type: image ? 'image' : 'document',
                                        buffer: mediaBuf2,
                                        filename,
                                        mimetype: media.mimetype
                                    });
                                } else {
                                    await menuController.handleIncomingMessage(sock, jid, caption);
                                }
                            } else {
                                // Recibimos una imagen/documento sin caption y sin espera de
                                // comprobante pendiente.
                                // Si el cliente tiene un PEDIDO EN CURSO, lo más probable es que
                                // sea el comprobante que el asistente IA pidió pero quedó sin
                                // waitingFile (el LLM lo pide en texto sin la action, o un texto
                                // intermedio limpió la espera). Lo pasamos al menú para finalizarlo.
                                const pedidoPendiente = stateService.getUserOrder(jid);
                                if (pedidoPendiente && pedidoPendiente.length > 0) {
                                    try {
                                        const buffer = await downloadMediaMessage(msg);
                                        await menuController.handleIncomingMessage(sock, jid, caption, {
                                            type: image ? 'image' : 'document',
                                            buffer,
                                            filename,
                                            mimetype: media.mimetype
                                        });
                                    } catch (err) {
                                        console.error(`${ts()} [${id}] Error descargando comprobante de ${jid}:`, err);
                                        await menuController.handleIncomingMessage(sock, jid, caption);
                                    }
                                } else {
                                    // Sin pedido en curso, no quedamos mudos: reconocemos el
                                    // archivo y mostramos el menú.
                                    await menuController.sendPresenceTyping(sock, jid);
                                    await sock.sendMessage(jid, { text: '📎 Recibí tu archivo. Si era un comprobante de pago, ya fue enviado.\n\nEscribí *0* para volver al inicio.' }).catch(() => {});
                                    await menuController.handleIncomingMessage(sock, jid, '0');
                                }
                            }
                        } else if (text) {
                            // Si hay un archivo/comprobante pendiente y llega texto (no media),
                            // delegar directo al menú (limpia la espera de archivo).
                            const waitingFileText = stateService.getWaitingForFile(jid);
                            if (waitingFileText) {
                                await menuController.handleIncomingMessage(sock, jid, text);
                            } else {
                                // Traductor: interpreta lenguaje natural → trigger del menú.
                                // - devuelve false: el menú procesa el texto tal cual
                                // - devuelve un trigger (string): el menú procesa ese trigger
                                // - devuelve {derivado:true}: el traductor ya respondió/derivó
                                const traduccion = await aiTranslatorController.handleMessage(sock, jid, text, { pushName: msg.pushName }).catch(() => false);
                                if (traduccion && typeof traduccion === 'object' && traduccion.derivado) {
                                    // El traductor derivó a un vendedor / finalizó su asistencia
                                    continue;
                                }
                                if (typeof traduccion === 'string' && traduccion) {
                                    // Si el traductor ya detectó la cantidad en el lenguaje
                                    // natural ("una muzarella y una coca"), agregamos DIRECTO y
                                    // en silencio (solo "✅ Añadido: N x Producto"), sin el prompt
                                    // "¿Cuántos querés?" ni re-mostrar el menú por cada ítem.
                                    const intentTr = stateService.getUserIntent(jid);
                                    const directOk = (intentTr && intentTr.cantidad)
                                        ? await menuController.addItemDirect(sock, jid, traduccion, intentTr.cantidad)
                                        : false;
                                    stateService.clearUserIntent(jid);
                                    if (!directOk) {
                                        await menuController.handleIncomingMessage(sock, jid, traduccion);
                                        const pendingCant = stateService.getPendingQuantityItem(jid);
                                        const intentTr2 = stateService.getUserIntent(jid);
                                        if (pendingCant && intentTr2 && intentTr2.cantidad) {
                                            await menuController.handleIncomingMessage(sock, jid, String(intentTr2.cantidad));
                                            stateService.clearUserIntent(jid);
                                        }
                                    }
                                    // Multi-pedido: el traductor cacheó ítems extra
                                    // ("una muzzarella y una coca"). Los procesamos en cadena
                                    // para que el menú los agregue todos en silencio.
                                    const pendItems = stateService.getPendingOrderItems(jid);
                                    if (pendItems && pendItems.length > 0) {
                                        stateService.clearPendingOrderItems(jid);
                                        for (const it of pendItems) {
                                            const ok = await menuController.addItemDirect(sock, jid, it.trigger, it.cantidad);
                                            if (!ok) {
                                                await menuController.handleIncomingMessage(sock, jid, String(it.trigger));
                                                const pc = stateService.getPendingQuantityItem(jid);
                                                if (pc && it.cantidad) {
                                                    await menuController.handleIncomingMessage(sock, jid, String(it.cantidad));
                                                }
                                            }
                                            stateService.clearUserIntent(jid);
                                        }
                                    }
                                    // EL ASISTENTE CONTINÚA EL FLUJO: tras agregar productos,
                                    // el bot resumen el pedido y guía el siguiente paso en vez de
                                    // quedar mudo ("¿querés algo más? / listo para pagar").
                                    const order = stateService.getUserOrder(jid);
                                    if (order && order.length > 0 && (directOk || (pendItems && pendItems.length > 0))) {
                                        let total = 0;
                                        const lineas = order.map(it => {
                                            const sub = (Number(it.price) || 0) * (it.quantity || 1);
                                            total += sub;
                                            return `- ${it.text}${it.price ? ` ($${sub})` : ''}`;
                                        });
                                        const resumen = `Tu pedido por ahora:\n${lineas.join('\n')}\n💰 Total: $${total}\n\n¿Querés sumar algo más? Decime el producto, o escribí "nada más" / "listo" para pasar a pagar.`;
                                        await sock.sendMessage(jid, { text: resumen }).catch(() => {});
                                    }
                                } else {
                                    await menuController.handleIncomingMessage(sock, jid, text);
                                }
                            }
                        }
                    }
                }
            }
        });

    } catch (error) {
        console.error(`${ts()} [${id}] Critical error during startup:`, error);
        botQRs[id].status = 'error';
        setTimeout(() => startBot(botConfig), 10000);
    }
}

async function main() {
    // Initialize Neon DB
    await termsService.ensureTable();
    await userService.init();
    await billingService.ensureTable();
    await configService.ensureTable();
    await configService.seed();
    await botConfigService.ensureTable();
    await aiUsageService.ensureTable();
    const { ensureMenuTables } = require('./services/menuDbService');
    await ensureMenuTables();
    logger.initConsoleCapture();

    // API: Check terms approval status
    appRouter.get('/api/terms/status/:userId', async (req, res) => {
        const loggedUser = req.user;
        const userId = req.params.userId;
        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== userId && loggedUser.idCliente !== loggedUser.username) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        const approved = await termsService.hasApproved(userId);
        res.json({ approved });
    });

    // API: Approve terms
    appRouter.post('/api/terms/approve', async (req, res) => {
        const loggedUser = req.user;
        const userId = String(loggedUser.idCliente || loggedUser.username);
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
        const ua = req.headers['user-agent'] || '';
        const ok = await termsService.approve(userId, loggedUser.username, 'v1.1', ip, ua);
        if (ok) {
            await userService.updateTermsDate(userId);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'Failed to save approval' });
        }
    });

    // API: Estado de la suscripción del usuario logueado
    appRouter.get('/api/mi-suscripcion', async (req, res) => {
        const loggedUser = req.user;
        const user = await userService.getUserByIdCliente(loggedUser.idCliente);
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

        const estado = billingService.estadoSuscripcion(user.fechaVencimiento, user.trialEndDate);
        const fechaSusp = billingService.fechaSuspension(user.fechaVencimiento);
        const sub = await billingService.getSuscripcionByIdCliente(loggedUser.idCliente);
        const diasRestantesTrial = billingService.diasRestantesTrial(user.trialEndDate);

        res.json({
            email: user.email,
            nombreCliente: user.nombreCliente,
            activo: user.activo,
            estado,
            fechaSuscripcion: user.fecha_suscripcion,
            fechaPago: user.fechaPago,
            fechaVencimiento: user.fechaVencimiento,
            fechaSuspension: fechaSusp ? fechaSusp.toISOString() : null,
            diasVencido: billingService.diasVencido(user.fechaVencimiento),
            tienePreaprobacion: !!(sub && sub.preapproval_id),
            trialStartDate: user.trialStartDate,
            trialEndDate: user.trialEndDate,
            diasRestantesTrial: diasRestantesTrial >= 0 ? diasRestantesTrial : null
        });
    });

    // API: Historial de pagos/facturas de la suscripción del usuario logueado
    appRouter.get('/api/mis-pagos', async (req, res) => {
        const loggedUser = req.user;
        const facturas = await billingService.getFacturasByIdCliente(loggedUser.idCliente);
        const sub = await billingService.getSuscripcionByIdCliente(loggedUser.idCliente);

        res.json({
            facturas: facturas.map(f => ({
                paymentId: f.paymentId,
                tipo: f.tipo,
                ptoVta: f.ptoVta,
                cbteNro: f.cbteNro,
                cae: f.cae,
                fechaCbte: f.fechaCbte,
                monto: Number(f.monto),
                periodoDesde: f.periodoDesde,
                periodoHasta: f.periodoHasta,
                createdAt: f.createdAt
            })),
            suscripcion: sub ? {
                preapprovalId: sub.preapproval_id,
                email: sub.email,
                nombreCliente: sub.nombre_cliente,
                fechaPago: sub.fecha_pago,
                fechaVencimiento: sub.fecha_vencimiento,
                estado: sub.estado
            } : null
        });
    });

    // API: Registrar evento de uso del dashboard (tracking de actividad del usuario)
    appRouter.post('/api/track-event', async (req, res) => {
        const loggedUser = req.user;
        const { action, entity, message, meta } = req.body || {};
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
        if (!action) return res.status(400).json({ error: 'action requerido' });
        await logService.track({
            userId: String(loggedUser.idCliente || loggedUser.username),
            action: String(action).slice(0, 100),
            entity: String(entity || '').slice(0, 100),
            message: String(message || '').slice(0, 500),
            meta: meta || null,
            ip
        });
        res.json({ ok: true });
    });

    // API: Obtener estado de un bot
    appRouter.get('/api/bot/status/:id', async (req, res) => {
        const id = req.params.id;
        const loggedUser = req.user;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== id) {
            return res.status(403).json({
                error: 'Unauthorized'
            });
        }

        const data = botQRs[id];
        if (!data) return res.status(404).json({
            error: 'Not found'
        });

        // Marcar actividad del visor
        data.lastActiveViewer = Date.now();

        // Si hay un QR pendiente de generar imagen, hacerlo ahora
        if (data.status === 'qr_ready' && !data.qr && data.rawQr) {
            try {
                data.qr = await QRCode.toDataURL(data.rawQr);
            } catch (err) {
                console.error(`${ts()} [${id}] Error lazy-generating QR:`, err);
            }
        }

        let suscripcion = null;
        if (loggedUser.idCliente !== 'admin') {
            const user = await userService.getUserByIdCliente(loggedUser.idCliente);
            if (user) {
                const estado = billingService.estadoSuscripcion(user.fechaVencimiento, user.trialEndDate);
                const fechaSusp = billingService.fechaSuspension(user.fechaVencimiento);
                const diasRestantesTrial = billingService.diasRestantesTrial(user.trialEndDate);
                suscripcion = {
                    estado,
                    fechaVencimiento: user.fechaVencimiento,
                    fechaSuspension: fechaSusp ? fechaSusp.toISOString() : null,
                    trialEndDate: user.trialEndDate,
                    diasRestantesTrial: diasRestantesTrial >= 0 ? diasRestantesTrial : null
                };
            }
        }

        res.json({
            status: data.status,
            qr: data.qr,
            lastUpdate: data.lastUpdate,
            suscripcion
        });
    });

    // API: Iniciar conexión de un bot
    appRouter.post('/api/bot/start/:id', async (req, res) => {
        const id = req.params.id;
        const loggedUser = req.user;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== id) {
            return res.status(403).json({
                error: 'Unauthorized'
            });
        }

        const data = botQRs[id];
        if (!data || !data.config) return res.status(404).json({
            error: 'Config not found'
        });

        // Bloquear inicio si la suscripción está vencida o en período de gracia
        if (loggedUser.idCliente !== 'admin') {
            const user = await userService.getUserByIdCliente(loggedUser.idCliente);
            const estado = user ? billingService.estadoSuscripcion(user.fechaVencimiento, user.trialEndDate) : 'sin_suscripcion';
            if (estado === 'gracia' || estado === 'suspendida' || estado === 'trial_vencido') {
                return res.status(403).json({
                    success: false,
                    error: estado === 'trial_vencido'
                        ? 'Tu prueba gratuita terminó. Activá tu plan para volver a usar el bot.'
                        : 'Suscripción vencida. Regularizá el pago para volver a activar tu bot.'
                });
            }
            if (user && !user.emailVerified) {
                return res.status(403).json({
                    success: false,
                    error: 'Verificá tu email para poder iniciar el bot.'
                });
            }
        }

        if (data.status === 'connected' || data.status === 'connecting' || data.status === 'qr_ready') {
            return res.json({
                success: true,
                message: 'Already running'
            });
        }

        logger.info('bot', id, 'Bot iniciado manualmente');
        logService.track({ userId: loggedUser.idCliente, action: 'bot_iniciado', entity: 'bot', message: 'Inició el bot de WhatsApp' }).catch(() => {});
        startBot(data.config, true);
        res.json({
            success: true,
            message: 'Starting...'
        });
    });

    // API: Detener conexión de un bot (por inactividad/visibilidad)
    appRouter.post('/api/bot/stop/:id', async (req, res) => {
        const id = req.params.id;
        const loggedUser = req.user;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== id) {
            return res.status(403).json({
                error: 'Unauthorized'
            });
        }

        const data = botQRs[id];
        if (!data) return res.status(404).json({
            error: 'Not found'
        });

        // Solo detener si está en estados de "espera de QR"
        if (data.status === 'qr_ready' || data.status === 'starting' || data.status === 'connecting') {
            console.log(`${ts()} [${id}] Stopping connection explicitly (User left page)`);
            if (data.sock) {
                try {
                    data.sock.end();
                } catch (e) {}
            }
            data.status = 'stopped_inactivity';
            data.qr = null;
            data.rawQr = null;
            data.qrReadyTimestamp = null;
            return res.json({
                success: true,
                message: 'Stopped'
            });
        }

        res.json({
            success: true,
            message: 'No action needed'
        });
    });

    // Integrated Dashboard routes
    appRouter.use('/', dashboard.setupRoutes());

    // Nueva ruta /qr dinámica
    appRouter.get('/qr', async (req, res) => {
        const loggedUser = req.user;
        
        // Ensure bot entries are initialized for the current user/clients
        if (loggedUser.idCliente === 'admin') {
            const allUsers = await userService.getUsers();
            allUsers.forEach(u => initializeBotEntry(u));
        } else {
            initializeBotEntry(loggedUser);
        }

        const bots = Object.entries(botQRs).filter(([id]) => {
            if (loggedUser.idCliente === 'admin') return true;
            return id === loggedUser.idCliente;
        });

        let html = `
        <html>
            <head>
                <title>WhatsApp Bot QR Status</title>
                <script src="/js/robot-logo.js"></script>
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
                    .terms-summary { width: 100%; max-width: 1000px; margin-top: 30px; padding: 20px 25px; background: var(--bg-box); border: 1px solid var(--border-color); border-radius: 12px; font-size: 13px; color: var(--text-muted); line-height: 1.6; }
                    .terms-summary strong { color: var(--text-main); }
                    .terms-summary a { color: var(--primary-color); text-decoration: none; font-weight: 600; }
                    .terms-summary a:hover { text-decoration: underline; }
                    .terms-notice { display: none; width: 100%; max-width: 1000px; margin-bottom: 20px; padding: 14px 20px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; font-size: 14px; color: #856404; text-align: center; }
                    .terms-notice a { color: #856404; font-weight: 700; cursor: pointer; text-decoration: underline; }
                    .terms-modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 2000; align-items: center; justify-content: center; padding: 20px; }
                    .terms-modal-overlay.open { display: flex; }
                    .terms-modal { background: white; border-radius: 16px; padding: 0; max-width: 560px; width: 100%; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
                    .terms-modal-header { padding: 20px 24px 12px; border-bottom: 1px solid var(--border-color); }
                    .terms-modal-header h3 { margin: 0; font-size: 18px; color: var(--text-main); }
                    .terms-modal-body { flex: 1; overflow-y: auto; padding: 16px 24px; font-size: 13px; color: var(--text-muted); line-height: 1.7; }
                    .terms-modal-body h4 { color: var(--text-main); margin: 16px 0 8px; font-size: 14px; }
                    .terms-modal-body p, .terms-modal-body li { margin: 6px 0; }
                    .terms-modal-body ul { padding-left: 20px; }
                    .terms-modal-footer { padding: 16px 24px; border-top: 1px solid var(--border-color); display: flex; gap: 10px; justify-content: flex-end; }
                    .terms-modal-footer button { padding: 10px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; border: none; transition: all 0.2s; }
                    .terms-btn-approve { background: var(--primary-color); color: white; }
                    .terms-btn-approve:hover:not(:disabled) { background: var(--primary-hover); }
                    .terms-btn-approve:disabled { background: #ccc; cursor: not-allowed; }
                    .terms-btn-cancel { background: var(--bg-box); color: var(--text-muted); border: 1px solid var(--border-color) !important; }
                    .terms-btn-cancel:hover { background: #eee; }
                    .terms-scroll-hint { font-size: 11px; color: #999; padding: 0 24px 8px; text-align: center; }
                    @media (max-width: 768px) {
                        body { padding: 12px; }
                        .header-nav { flex-direction: column; gap: 12px; }
                        .header-nav h1 { font-size: 20px; }
                        .bot-card { width: 100%; max-width: 100%; box-sizing: border-box; padding: 16px; }
                        .qr-img { width: 200px; height: 200px; }
                        .btn-back { width: 100%; justify-content: center; box-sizing: border-box; }
                        .terms-modal { max-height: 90vh; margin: 10px; }
                        .terms-modal-body { padding: 12px 16px; font-size: 12px; }
                        .terms-modal-footer { flex-direction: column; }
                        .terms-modal-footer button { width: 100%; }
                    }
                </style>
            </head>
            <body>
                    <div class="header-nav">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <a href="/" style="display:block;"><img src="/img/wamenu_logo_name.png" alt="WaMenu" style="width:100%;max-width:8em;height:auto;object-fit:contain;"></a>
                        <h1 style="font-size:1.2rem;margin:0;">WhatsApp Status</h1>
                    </div>
                    <div style="display: flex; gap: 10px;">
                        <a href="/app/" class="btn-back">Volver al Editor de Menú</a>
                        <a href="/app/logout" class="btn-back btn-danger" style="color: white; background: var(--error-color); border: none;">Salir</a>
                    </div>
                </div>
                ${!loggedUser.emailVerified ? '<div style="width:100%;max-width:1000px;padding:12px 20px;margin-bottom:16px;background:#fff4e5;border:1px solid #ff980040;border-radius:8px;font-size:14px;color:#b45309;text-align:center;">Tu email no está verificado. Revisá tu casilla o <a href="/app/verify-email-sent" style="color:#b45309;text-decoration:underline;font-weight:600;">reenviá el email de verificación</a>.</div>' : ''}
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

                <div class="terms-notice" id="termsNotice">
                    Debes aceptar los Términos y Condiciones antes de poder usar el bot. <a onclick="openTermsModal()">Revisar ahora</a>
                </div>

                <div class="terms-summary">
                    <strong>Resumen de Términos y Condiciones (v1.1):</strong> Wamenu actúa exclusivamente como proveedor SaaS e intermediario técnico para la automatización y recepción de pedidos por WhatsApp, deslindándose de toda responsabilidad sobre las operaciones comerciales del negocio o eventuales bloqueos de línea aplicados por WhatsApp/Meta. Las planillas de Google Sheets con los pedidos se alojan en la infraestructura asignada por Wamenu, actuando la empresa como custodio técnico y confidencial de la información conforme a la Ley 25.326. El comercio conserva la propiedad de sus datos y asume la responsabilidad del pago puntual de la suscripción periódica para evitar la suspensión del servicio.
                    <br><br>
                    <a href="/terminos_condiciones/terminos_y_condiciones_wamenu_v1.1.pdf" target="_blank">Ver Términos y Condiciones completos (PDF)</a>
                </div>

                <div class="terms-modal-overlay" id="termsModal">
                    <div class="terms-modal">
                        <div class="terms-modal-header">
                            <h3>Términos y Condiciones del Servicio Wamenu (v1.1)</h3>
                        </div>
                        <div class="terms-modal-body" id="termsModalBody">
                            <h4>1. Naturaleza del Servicio</h4>
                            <p>Wamenu actúa exclusivamente como un proveedor SaaS (Software como Servicio) e intermediario técnico para la automatización y recepción de pedidos por WhatsApp. La plataforma no participa ni es responsable de las operaciones comerciales, transacciones, entregas, devoluciones ni de cualquier aspecto de la relación comercial entre el comercio y sus clientes.</p>

                            <h4>2. Responsabilidad sobre Bloqueos</h4>
                            <p>Wamenu se deslinda de toda responsabilidad sobre eventuales bloqueos, restricciones o suspensiones de líneas de WhatsApp aplicados por WhatsApp/Meta. El comercio es el único responsable del cumplimiento de las políticas de uso de WhatsApp y de las consecuencias que pudieran derivarse del uso de la plataforma.</p>

                            <h4>3. Almacenamiento de Datos</h4>
                            <p>Las planillas de Google Sheets que contienen los pedidos se alojan en la infraestructura asignada por Wamenu. La empresa actúa como custodio técnico y confidencial de la información conforme a la Ley 25.326 (Protección de Datos Personales). El comercio conserva la propiedad total de sus datos.</p>

                            <h4>4. Suscripción y Pagos</h4>
                            <p>El comercio asume la responsabilidad del pago puntual de la suscripción periódica. El incumplimiento del pago podrá dar lugar a la suspensión temporal o definitiva del servicio, sin que ello genere derecho a indemnización o reembolso.</p>

                            <h4>5. Uso Aceptable</h4>
                            <p>El comercio se compromete a utilizar la plataforma de manera lícita y conforme a las condiciones establecidas. Queda prohibido el uso de la plataforma para fines ilegales, fraudulentos o que vulneren derechos de terceros.</p>

                            <h4>6. Disponibilidad del Servicio</h4>
                            <p>Wamenu no garantiza la disponibilidad ininterrumpida del servicio. Podrán existir interrupciones por mantenimiento, actualizaciones o causas ajenas al control de la empresa.</p>

                            <h4>7. Limitación de Responsabilidad</h4>
                            <p>En ningún caso Wamenu será responsable por daños indirectos, incidentales, especiales o consecuentes que pudieran derivarse del uso o imposibilidad de uso de la plataforma.</p>

                            <h4>8. Modificaciones</h4>
                            <p>Wamenu se reserva el derecho de modificar los presentes Términos y Condiciones en cualquier momento. Las modificaciones serán notificadas a los usuarios y el uso continuado de la plataforma implicará la aceptación de las mismas.</p>

                            <h4>9. Ley Aplicable</h4>
                            <p>Los presentes Términos y Condiciones se rigen por las leyes de la República Argentina. Toda controversia será sometida a los tribunales competentes de la ciudad de Bahía Blanca, Provincia de Buenos Aires.</p>
                        </div>
                        <div class="terms-scroll-hint" id="termsScrollHint">Desplázate hasta el final para habilitar la aprobación</div>
                        <div class="terms-modal-footer">
                            <button class="terms-btn-cancel" onclick="closeTermsModal()">Cancelar</button>
                            <button class="terms-btn-approve" id="termsApproveBtn" disabled onclick="approveTerms()">Aprobar</button>
                        </div>
                    </div>
                </div>

                <script>
                    const botIds = ${JSON.stringify(bots.map(([id]) => id))};
                    const currentUserId = '${String(loggedUser.idCliente || loggedUser.username)}';
                    let termsApproved = false;

                    // --- Terms & Conditions Logic ---
                    async function checkTermsApproval() {
                        try {
                            const res = await fetch('/app/api/terms/status/' + currentUserId);
                            if (!res.ok) return;
                            const data = await res.json();
                            termsApproved = data.approved;
                            const notice = document.getElementById('termsNotice');
                            if (!termsApproved) {
                                notice.style.display = 'block';
                            } else {
                                notice.style.display = 'none';
                            }
                        } catch (e) {
                            console.error('Error checking terms:', e);
                        }
                    }

                    function openTermsModal() {
                        document.getElementById('termsModal').classList.add('open');
                        document.getElementById('termsApproveBtn').disabled = true;
                        document.getElementById('termsScrollHint').style.display = 'block';
                        const body = document.getElementById('termsModalBody');
                        body.scrollTop = 0;
                    }

                    function closeTermsModal() {
                        document.getElementById('termsModal').classList.remove('open');
                    }

                    document.getElementById('termsModalBody').addEventListener('scroll', function() {
                        const el = this;
                        const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 10;
                        if (atBottom) {
                            document.getElementById('termsApproveBtn').disabled = false;
                            document.getElementById('termsScrollHint').style.display = 'none';
                        }
                    });

                    async function approveTerms() {
                        const btn = document.getElementById('termsApproveBtn');
                        btn.disabled = true;
                        btn.textContent = 'Guardando...';
                        try {
                            const res = await fetch('/app/api/terms/approve', { method: 'POST' });
                            if (res.ok) {
                                termsApproved = true;
                                document.getElementById('termsNotice').style.display = 'none';
                                closeTermsModal();
                            } else {
                                alert('Error al guardar la aprobación. Intenta nuevamente.');
                                btn.disabled = false;
                                btn.textContent = 'Aprobar';
                            }
                        } catch (e) {
                            alert('Error de conexión. Intenta nuevamente.');
                            btn.disabled = false;
                            btn.textContent = 'Aprobar';
                        }
                    }

                    // Check terms on page load
                    checkTermsApproval();
                    // --- End Terms Logic ---

                    async function updateBotStatus(id) {
                        try {
                            const res = await fetch('/app/api/bot/status/' + id);
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

                    // Bloqueo por suscripción vencida (período de gracia o suspendido)
                    const sub = data.suscripcion;
                    const subBlocked = sub && (sub.estado === 'gracia' || sub.estado === 'suspendida' || sub.estado === 'trial_vencido');
                    if (subBlocked) {
                        const fechaSusp = sub.fechaSuspension ? new Date(sub.fechaSuspension).toLocaleDateString('es-AR') : '';
                        if (sub.estado === 'trial_vencido') {
                            qrContainer.innerHTML = '<p style="color: #dc2626; font-weight: bold;">Prueba gratuita terminada</p>';
                            instruction.textContent = 'Tu prueba de 30 días terminó. Activá tu plan para volver a usar el bot.';
                            actions.innerHTML = '<a href="/suscripcion" class="btn-action" style="text-decoration:none;display:inline-block;">Activar mi plan</a>';
                        } else {
                            qrContainer.innerHTML = '<p style="color: #b45309; font-weight: bold;">Suscripción vencida</p>';
                            instruction.textContent = sub.estado === 'gracia'
                                ? 'Tu suscripción venció. Podés seguir entrando a tu perfil, pero el bot no puede activarse hasta regularizar el pago. El servicio se suspenderá el ' + fechaSusp + '.'
                                : 'Tu suscripción está suspendida. Regularizá el pago para volver a usar tu bot.';
                            actions.innerHTML = '<button class="btn-action" disabled style="background:#ccc;">Suscripción vencida</button>';
                        }
                        return;
                    }

                    // Banner informativo para trial activo
                    const existingBanner = document.getElementById('trial-banner-' + id);
                    if (existingBanner) existingBanner.remove();
                    if (sub && sub.estado === 'trial' && sub.diasRestantesTrial !== null && sub.diasRestantesTrial !== undefined) {
                        const diasR = sub.diasRestantesTrial;
                        const bannerColor = diasR <= 2 ? '#dc2626' : (diasR <= 5 ? '#b45309' : '#00bc7d');
                        const bannerText = diasR === 0
                            ? 'Tu prueba termina hoy'
                            : 'Te quedan ' + diasR + ' día' + (diasR !== 1 ? 's' : '') + ' de prueba gratuita';
                        qrContainer.insertAdjacentHTML('beforebegin',
                            '<div id="trial-banner-' + id + '" style="box-sizing:border-box;width:100%;padding:10px 16px;margin-bottom:10px;background:' + bannerColor + '15;border:1px solid ' + bannerColor + '40;border-radius:8px;font-size:13px;color:' + bannerColor + ';text-align:center;font-weight:600;">' +
                            bannerText + (diasR <= 5 ? ' — <a href="/suscripcion" style="color:' + bannerColor + ';text-decoration:underline;">Activar plan</a>' : '') +
                            '</div>'
                        );
                    }

                            if (data.status === 'connected') {
                                qrContainer.innerHTML = '<p style="color: #00bc7d; font-weight: bold;">Sesión Activa ${icon('checkCircle', 'w-4 h-4 inline text-green-400')}</p>';
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
                            } else if (data.status === 'waiting_start' || data.status === 'stopped_inactivity' || data.status === 'logged_out' || data.status === 'disconnected' || data.status === 'timeout_qr' || data.status === 'suspended_subscription') {
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
                        if (!termsApproved) {
                            openTermsModal();
                            return;
                        }
                        const btn = document.querySelector('#actions-' + id + ' button');
                        if (btn) btn.disabled = true;
                        const res = await fetch('/app/api/bot/start/' + id, { method: 'POST' });
                        if (!res.ok) {
                            const errData = await res.json().catch(() => ({}));
                            alert(errData.error || 'No se pudo iniciar el bot.');
                            if (btn) btn.disabled = false;
                            updateBotStatus(id);
                            return;
                        }
                        updateBotStatus(id);
                    }

                    async function deleteSession(id) {
                        if (!confirm('¿Seguro que deseas borrar la sesión? Deberás escanear el QR nuevamente.')) return;
                        const btn = document.querySelector('#actions-' + id + ' button');
                        if (btn) btn.disabled = true;
                        await fetch('/app/reconnect/' + id, { method: 'POST' });
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
                                await fetch('/app/api/bot/stop/' + id, { method: 'POST' });
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
    appRouter.post('/reconnect/:botId', (req, res) => {
        const loggedUser = req.user;
        const botId = req.params.botId;

        if (loggedUser.idCliente !== 'admin' && loggedUser.idCliente !== botId) {
            return res.status(403).json({
                error: 'Unauthorized'
            });
        }

        const data = botQRs[botId];
        if (!data) return res.status(404).json({
            error: 'Bot not found'
        });

        try {
            if (data.sock) {
                try {
                    data.sock.end();
                } catch (e) {}
            }

            const authFolder = path.join(AUTH_SESSIONS_DIR, `auth_info_${botId}`);
            if (fs.existsSync(authFolder)) {
                fs.rmSync(authFolder, {
                    recursive: true,
                    force: true
                });
                console.log(`${ts()} [${botId}] Session deleted manually`);
            }

            botQRs[botId].status = 'logged_out';
            botQRs[botId].qr = null;
            botQRs[botId].rawQr = null;

            res.json({
                success: true
            });
        } catch (error) {
            console.error(`${ts()} [${botId}] Error during session deletion:`, error);
            res.status(500).json({
                error: 'Error'
            });
        }
    });

    // Iniciar bots dinámicamente desde Sheets
    const activeClients = await userService.getUsers(); // Obtener todos para inicializar config
    console.log(`${ts()} [System] Loading ${activeClients.length} potential clients...`);

    for (const client of activeClients) {
        if (client.idCliente === 'admin') continue;

        const entry = initializeBotEntry(client);
        const credsFile = path.join(entry.config.authFolder, 'creds.json');

        // Solo iniciar automáticamente si tiene sesión activa, el cliente está marcado como activo
        // y la suscripción está al día (no vencida ni en período de gracia).
        const estado = billingService.estadoSuscripcion(client.fechaVencimiento, client.trialEndDate);
        const suscOk = client.idCliente === 'admin' || estado === 'activa' || estado === 'sin_suscripcion' || estado === 'trial';

        if (fs.existsSync(credsFile) && client.activo && suscOk) {
            console.log(`${ts()} [System] Auto-starting active session for ${client.idCliente}`);
            startBot(entry.config);
        } else {
            console.log(`${ts()} [System] Bot ${client.idCliente} waiting for manual start (No active session, inactive or subscription expired).`);
        }
    }

    // Intervalo de limpieza por inactividad
    setInterval(() => {
        const now = Date.now();
        Object.entries(botQRs).forEach(([id, data]) => {
            // 1. Timeout de escaneo (30 segundos en estado qr_ready)
            if (data.status === 'qr_ready' && data.qrReadyTimestamp) {
                if (now - data.qrReadyTimestamp > 30000) {
                    console.log(`${ts()} [${id}] QR Scan Timeout (30s exceeded). Stopping...`);
                    data.status = 'timeout_qr';
                    if (data.sock) {
                        try {
                            data.sock.end();
                        } catch (e) {}
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
                    console.log(`${ts()} [${id}] Stopping connection due to inactive viewer (Saving memory)`);
                    if (data.sock) {
                        try {
                            data.sock.end();
                        } catch (e) {}
                    }
                    data.status = 'stopped_inactivity';
                    data.qr = null;
                    data.rawQr = null;
                    data.qrReadyTimestamp = null;
                }
            }

            // Si el bot está en qr_ready pero no hay visor activo hace 15 segundos, limpiar la imagen Base64 para liberar memoria
            if (data.status === 'qr_ready' && data.qr && (now - (data.lastActiveViewer || 0) > 15000)) {
                console.log(`${ts()} [${id}] Clearing QR image from memory (Still in qr_ready state)`);
                data.qr = null;
            }
        });
    }, 30000);
}

module.exports = { appRouter, main, stopBotConnection };