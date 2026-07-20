require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const userService = require('./app/src/services/userService');
const mercadoPagoService = require('./app/src/services/mercadoPagoService');
const emailService = require('./app/src/services/emailService');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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
        maxAge: 60 * 60 * 1000,
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict'
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

// Contacto: enviar email a info@wamenu.com.ar
app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    console.log('[Contact] Request recibido:', { name, email, messageLength: message?.length });
    if (!name || !email || !message) {
        console.log('[Contact] Faltan campos:', { name: !!name, email: !!email, message: !!message });
        return res.status(400).json({ error: 'Faltan campos' });
    }
    console.log('[Contact] RESEND_API_KEY configurada:', !!process.env.RESEND_API_KEY, process.env.RESEND_API_KEY?.substring(0, 6) + '...');
    console.log('[Contact] CONTACT_EMAIL_FROM:', process.env.CONTACT_EMAIL_FROM);
    try {
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
                <div style="background: #0f6b4f; color: white; padding: 20px; border-radius: 12px 12px 0 0; text-align: center;">
                    <h1 style="margin: 0; font-size: 1.3rem;">📩 Nuevo mensaje de contacto</h1>
                </div>
                <div style="background: #f8f9fa; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e0e0e0; border-top: none;">
                    <p style="font-size: 0.95rem; color: #333; margin: 0 0 12px;"><strong>Nombre:</strong> ${name}</p>
                    <p style="font-size: 0.95rem; color: #333; margin: 0 0 12px;"><strong>Email:</strong> ${email}</p>
                    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 16px 0;">
                    <p style="font-size: 0.95rem; color: #555; line-height: 1.6; white-space: pre-wrap;">${message}</p>
                </div>
            </div>
        `;
        const from = process.env.CONTACT_EMAIL_FROM || 'no-reply@wamenu.com.ar';
        const to = 'emilianohaag10@gmail.com';
        console.log('[Contact] Enviando email:', { from, to, reply_to: email });
        const result = await resend.emails.send({
            from,
            to,
            reply_to: email,
            subject: `📩 Contacto: ${name}`,
            html
        });
        console.log('[Contact] Resend respuesta:', JSON.stringify(result));
        res.json({ ok: true });
    } catch (err) {
        console.error('[Contact] Error enviando email:', err);
        console.error('[Contact] Error details:', JSON.stringify(err));
        res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function generatePassword(length = 10) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from(crypto.randomBytes(length), b => chars[b % chars.length]).join('');
}

function generateUsername(email) {
    const prefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    const suffix = crypto.randomBytes(3).toString('hex');
    return `${prefix}_${suffix}`;
}

function generateClientId() {
    return 'cli_' + crypto.randomBytes(4).toString('hex');
}

// MercadoPago: Crear suscripción
app.post('/api/mercadopago/create-subscription', async (req, res) => {
    try {
        const { name, email } = req.body;
        if (!name || !email) {
            return res.status(400).json({ error: 'Faltan nombre o email' });
        }

        const cfg = readConfig();
        const precio = cfg.precio_estandar != null ? cfg.precio_estandar : (process.env.PRECIO_ESTANDAR || '23000');
        const siteUrl = process.env.SITE_URL || `http://localhost:${port}`;

        // MP requiere una URL pública válida en back_url
        // Si estamos en localhost, usamos un placeholder y advertimos
        let mpBackUrl = `${siteUrl}/pago_exitoso`;
        if (mpBackUrl.includes('localhost') || mpBackUrl.includes('127.0.0.1')) {
            console.warn('[MercadoPago] Usando placeholder para back_url (localhost no es válido para MP).');
            console.warn('[MercadoPago] Para pruebas completas usá ngrok: https://ngrok.com');
            mpBackUrl = 'https://www.mercadopago.com.ar';
        }

        let preapproval;
        let payerEmail = email;
        try {
            preapproval = await mercadoPagoService.createPreapproval({
                reason: 'Suscripción Bot Menu - Plan Estándar',
                amount: Number(precio),
                payerEmail,
                backUrl: mpBackUrl,
                notificationUrl: `${siteUrl}/api/mercadopago/webhook`
            });
        } catch (mpErr) {
            const testBuyer = process.env.TEST_BUYER_EMAIL || 'test_user_123@testuser.com';
            if (process.env.MERCADOPAGO_ACCESS_TOKEN?.startsWith('TEST-')) {
                console.warn(`[MercadoPago] Reintentando con email de test: ${testBuyer}`);
                preapproval = await mercadoPagoService.createPreapproval({
                    reason: 'Suscripción Bot Menu - Plan Estándar',
                    amount: Number(precio),
                    payerEmail: testBuyer,
                    backUrl: mpBackUrl,
                    notificationUrl: `${siteUrl}/api/mercadopago/webhook`
                });
            } else {
                throw mpErr;
            }
        }

        // Guardar referencia del nombre asociado al preapproval (usar email original del formulario)
        const preapprovalRefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).preapproval_refs || {};
        preapprovalRefs[preapproval.id] = { name, email, fecha: new Date().toISOString() };
        writeConfig({ preapproval_refs: preapprovalRefs });

        res.json({
            init_point: preapproval.init_point,
            preapproval_id: preapproval.id
        });

        // Polling automático: verificar cada 5s si se aprobó el pago
        (async function pollPayment(pid, attempts) {
            if (attempts <= 0) return;
            await new Promise(r => setTimeout(r, 5000));
            try {
                const pa = await mercadoPagoService.getPreapproval(pid);
                if (pa.status === 'authorized' || pa.status === 'approved') {
                    const cfg = readConfig();
                    const refs = cfg.preapproval_refs || {};
                    const ref = refs[pid] || {};
                    if (ref.email) {
                        const username = generateUsername(ref.email);
                        const password = generatePassword();
                        const idCliente = generateClientId();
                        await userService.addUser({ idCliente, nombreCliente: ref.name || 'Cliente', user: username, password, spreadsheetId: process.env.SPREADSHEET_ID });
                        try { await emailService.sendWelcomeEmail({ to: ref.email, username, password, name: ref.name }); } catch {}
                        delete refs[pid];
                        writeConfig({ preapproval_refs: refs });
                        console.log(`[AutoPoll] Usuario creado: ${username} (${ref.email})`);
                    }
                } else {
                    pollPayment(pid, attempts - 1);
                }
            } catch { pollPayment(pid, attempts - 1); }
        })(preapproval.id, 120); // 120 intentos × 5s = 10 minutos
    } catch (error) {
        console.error('[MercadoPago] Error creating subscription:', error);
        res.status(500).json({ error: 'Error al crear la suscripción' });
    }
});

// MercadoPago: Retorno de pago exitoso
app.get('/pago_exitoso', async (req, res) => {
    const { preapproval_id, status, collection_id, payment_id } = req.query;
    const paymentId = preapproval_id || collection_id || payment_id;

    // Si no viene de un pago, mostrar página estática
    if (!paymentId) {
        return res.sendFile(path.join(__dirname, 'public', 'pago_exitoso.html'));
    }

    try {
        // Obtener la preaprobación de MP
        const preapproval = await mercadoPagoService.getPreapproval(paymentId);

        const mpStatus = preapproval.status;

        // Recuperar datos desde las referencias guardadas (prioridad sobre lo que devuelve MP)
        const cfg = readConfig();
        const refs = cfg.preapproval_refs || {};
        const ref = refs[paymentId] || {};
        const payerEmail = ref.email || preapproval.payer_email || req.query.email;
        const payerName = ref.name || preapproval.reason || 'Cliente';

        // Si no hay referencia, ya fue procesado (evitar duplicados)
        const yaProcesado = cfg.pagos_procesados && cfg.pagos_procesados[paymentId];
        if (!ref.email || yaProcesado) {
            if (refs[paymentId]) { delete refs[paymentId]; writeConfig({ preapproval_refs: refs }); }
            if (yaProcesado) return res.redirect(`/suscripcion_exitosa?username=${encodeURIComponent(cfg.pagos_procesados[paymentId].username)}&password=${encodeURIComponent(cfg.pagos_procesados[paymentId].password)}&email=${encodeURIComponent(cfg.pagos_procesados[paymentId].email)}`);
            return res.redirect('/');
        }

        if (mpStatus === 'authorized' || mpStatus === 'approved') {
            // Generar credenciales
            const username = generateUsername(payerEmail);
            const password = generatePassword();
            const idCliente = generateClientId();

            // Guardar usuario en Google Sheets
            await userService.addUser({
                idCliente,
                nombreCliente: payerName,
                user: username,
                password,
                spreadsheetId: process.env.SPREADSHEET_ID
            });

            console.log(`[Suscripción] Usuario creado: ${username} (${payerEmail})`);

            // Marcar como procesado y limpiar referencia
            const pagosProc = cfg.pagos_procesados || {};
            pagosProc[paymentId] = { username, password: password, email: payerEmail };
            if (refs[paymentId]) {
                delete refs[paymentId];
                writeConfig({ preapproval_refs: refs, pagos_procesados: pagosProc });
            } else {
                writeConfig({ pagos_procesados: pagosProc });
            }

            // Enviar email de bienvenida
            try {
                await emailService.sendWelcomeEmail({
                    to: payerEmail,
                    username,
                    password,
                    name: payerName
                });
                console.log(`[Suscripción] Email enviado a ${payerEmail}`);
            } catch (emailErr) {
                console.error('[Suscripción] Error enviando email:', emailErr);
            }

            // Redirigir a página de éxito con credenciales
            const successUrl = `/suscripcion_exitosa?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&email=${encodeURIComponent(payerEmail)}`;
            return res.send(`
                <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0fdf4;">
                <div style="text-align:center;background:white;padding:40px;border-radius:16px;max-width:400px;">
                    <div style="font-size:3rem;margin-bottom:12px;">✅</div>
                    <h2 style="color:#222;">¡Pago exitoso!</h2>
                    <p style="color:#666;">Redirigiendo al panel...</p>
                </div>
                <script>
                    if (window.opener) {
                        window.opener.postMessage('pago_ok', '*');
                        window.opener.location.href = '${successUrl}';
                    } else {
                        window.location.href = '${successUrl}';
                    }
                    setTimeout(function() { window.close(); }, 500);
                <\/script>
                </body></html>
            `);
        } else {
            return res.send(`
                <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa;">
                    <div style="text-align:center;background:white;padding:48px;border-radius:16px;max-width:420px;">
                        <div style="font-size:3rem;margin-bottom:16px;">⏳</div>
                        <h2 style="color:#333;">Pago pendiente</h2>
                        <p style="color:#666;line-height:1.6;">El pago está en estado: <strong>${mpStatus}</strong>. Te notificaremos cuando se confirme.</p>
                        <a href="/" style="display:inline-block;margin-top:20px;color:#0f6b4f;">Volver al inicio</a>
                    </div>
                </body></html>
            `);
        }
    } catch (error) {
        console.error('[MercadoPago] Error processing payment:', error);
        res.status(500).send(`
            <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa;">
                <div style="text-align:center;background:white;padding:48px;border-radius:16px;max-width:420px;">
                    <div style="font-size:3rem;margin-bottom:16px;">❌</div>
                    <h2 style="color:#333;">Error procesando el pago</h2>
                    <p style="color:#666;line-height:1.6;">Ocurrió un error al procesar tu suscripción. Contactanos por WhatsApp.</p>
                    <a href="/" style="display:inline-block;margin-top:20px;color:#0f6b4f;">Volver al inicio</a>
                </div>
            </body></html>
        `);
    }
});

// MercadoPago: Endpoint de prueba para simular pago exitoso (solo en desarrollo local)
app.post('/api/mercadopago/test-complete', async (req, res) => {
    const { preapproval_id } = req.body;
    if (!preapproval_id) return res.status(400).json({ error: 'Falta preapproval_id' });

    try {
        // Recuperar datos de la preaprobación desde MP
        const preapproval = await mercadoPagoService.getPreapproval(preapproval_id);

        // Recuperar datos desde config.json (prioridad sobre lo que devuelve MP)
        const cfg = readConfig();
        const refs = cfg.preapproval_refs || {};
        const ref = refs[preapproval_id] || {};
        const payerEmail = ref.email || preapproval.payer_email;
        const name = ref.name || preapproval.reason || 'Cliente';

        // Generar credenciales
        const username = generateUsername(payerEmail || 'test@test.com');
        const password = generatePassword();
        const idCliente = generateClientId();

        // Guardar usuario
        await userService.addUser({
            idCliente,
            nombreCliente: name,
            user: username,
            password,
            spreadsheetId: process.env.SPREADSHEET_ID
        });
        console.log(`[Test] Usuario creado: ${username} (${payerEmail})`);

        // Enviar email
        try {
            if (payerEmail) {
                await emailService.sendWelcomeEmail({ to: payerEmail, username, password, name });
            }
        } catch (emailErr) {
            console.error('[Test] Error enviando email:', emailErr);
        }

        // Limpiar referencia guardada
        if (refs[preapproval_id]) {
            delete refs[preapproval_id];
            writeConfig({ preapproval_refs: refs });
        }

        res.json({ success: true, username, password, email: payerEmail, name });
    } catch (error) {
        console.error('[Test] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// MercadoPago: IPN Webhook
app.post('/api/mercadopago/webhook', async (req, res) => {
    console.log('[MercadoPago Webhook] Received:', JSON.stringify(req.body));
    res.sendStatus(200);

    try {
        const { type, data } = req.body;
        if (type === 'subscription_preapproval' && data?.id) {
            const preapproval = await mercadoPagoService.getPreapproval(data.id);
            if (preapproval.status === 'authorized' || preapproval.status === 'approved') {
                const cfg = readConfig();
                const refs = cfg.preapproval_refs || {};
                const ref = refs[data.id] || {};
                if (ref.email) {
                    const username = generateUsername(ref.email);
                    const password = generatePassword();
                    const idCliente = generateClientId();

                    await userService.addUser({
                        idCliente,
                        nombreCliente: ref.name || 'Cliente',
                        user: username,
                        password,
                        spreadsheetId: process.env.SPREADSHEET_ID
                    });

                    try {
                        await emailService.sendWelcomeEmail({ to: ref.email, username, password, name: ref.name });
                    } catch (emailErr) {
                        console.error('[Webhook] Error enviando email:', emailErr);
                    }

                    delete refs[data.id];
                    writeConfig({ preapproval_refs: refs });
                    console.log(`[Webhook] Usuario creado: ${username} (${ref.email})`);
                }
            }
        }
    } catch (err) {
        console.error('[Webhook] Error processing:', err);
    }
});

// Endpoint para que el frontend consulte estado del pago
app.get('/api/mercadopago/check-status', async (req, res) => {
    const { preapproval_id } = req.query;
    if (!preapproval_id) return res.json({ status: 'unknown' });
    try {
        const pa = await mercadoPagoService.getPreapproval(preapproval_id);
        res.json({ status: pa.status });
    } catch {
        res.json({ status: 'unknown' });
    }
});

// Página de suscripción exitosa
app.get('/suscripcion_exitosa', (req, res) => {
    const { username, password, email } = req.query;
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Suscripción exitosa - Bot Menu</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', -apple-system, sans-serif;
                    background: linear-gradient(135deg, #f0fdf4 0%, #e8f5e9 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 24px;
                }
                .card {
                    background: white;
                    border-radius: 20px;
                    padding: 48px 40px;
                    max-width: 480px;
                    width: 100%;
                    text-align: center;
                    box-shadow: 0 8px 40px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.02);
                }
                .check {
                    width: 72px; height: 72px;
                    border-radius: 50%;
                    background: #0f6b4f;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin: 0 auto 24px;
                    font-size: 2rem;
                    color: white;
                }
                h1 { font-size: 1.6rem; font-weight: 800; color: #222; margin-bottom: 8px; }
                .sub { color: #666; font-size: 1rem; line-height: 1.5; margin-bottom: 32px; }
                .creds {
                    background: #f8fdfb;
                    border: 1px solid #d4ede3;
                    border-radius: 12px;
                    padding: 20px;
                    text-align: left;
                    margin-bottom: 24px;
                }
                .creds p { font-size: 0.75rem; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
                .creds .row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 0;
                    border-bottom: 1px solid #e8f5e9;
                    font-size: 0.92rem;
                }
                .creds .row:last-child { border-bottom: none; }
                .creds .label { color: #555; }
                .creds .value { font-family: monospace; background: #e8f5e9; padding: 3px 8px; border-radius: 4px; font-weight: 600; color: #0f6b4f; font-size: 0.85rem; }
                .alert {
                    background: #fff3e0;
                    border: 1px solid #ffe0b2;
                    border-radius: 8px;
                    padding: 14px;
                    font-size: 0.85rem;
                    color: #e65100;
                    margin-bottom: 24px;
                    text-align: left;
                    line-height: 1.5;
                }
                .btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    padding: 14px 32px;
                    background: #0f6b4f;
                    color: white;
                    border: none;
                    border-radius: 10px;
                    font-size: 1rem;
                    font-weight: 700;
                    font-family: inherit;
                    cursor: pointer;
                    text-decoration: none;
                    transition: background 0.2s, transform 0.15s;
                }
                .btn:hover { background: #0c5841; transform: translateY(-1px); }
                .footer-text { margin-top: 24px; font-size: 0.8rem; color: #aaa; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="check">✓</div>
                <h1>¡Suscripción exitosa! 🎉</h1>
                <p class="sub">Tu suscripción se activó correctamente.<br>Te enviamos un email con tus credenciales.</p>

                <div class="creds">
                    <p>Tus credenciales de acceso</p>
                    <div class="row">
                        <span class="label">Usuario</span>
                        <span class="value" id="displayUser">${username || '—'}</span>
                    </div>
                    <div class="row">
                        <span class="label">Contraseña</span>
                        <span class="value" id="displayPass">${password || '—'}</span>
                    </div>
                    ${email ? `<div class="row">
                        <span class="label">Email</span>
                        <span class="value" style="font-family:inherit;background:transparent;color:#555;">${email}</span>
                    </div>` : ''}
                </div>

                <div class="alert">
                    ⚠️ <strong>Importante:</strong> Guardá tus credenciales. No podremos recuperar tu contraseña.
                    Por seguridad, te recomendamos cambiar la contraseña después del primer ingreso.
                </div>

                <a href="/app/login" class="btn">Ir al Panel →</a>
                <p class="footer-text">Bot Menu &mdash; WhatsApp Business Automation</p>
            </div>
        </body>
        </html>
    `);
});

app.get('/pago_pendiente', (req, res) => {
    res.send('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;"><h2>⏳ Pago pendiente</h2></body></html>');
});

app.get('/pago_fallido', (req, res) => {
    res.send('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;"><h2>❌ Pago fallido</h2></body></html>');
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
