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
const billingService = require('./app/src/services/billingService');
const arcaService = require('./app/src/services/arcaService');
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
        precioEstandar: cfg.precio_estandar != null ? cfg.precio_estandar : (process.env.PRECIO_ESTANDAR || '22000'),
        trialGratis: cfg.trial_gratis !== false
    });
});

app.post('/api/config', (req, res) => {
    if (req.body.precio_estandar != null) {
        writeConfig({ precio_estandar: Number(req.body.precio_estandar) });
    }
    if (req.body.trial_gratis != null) {
        writeConfig({ trial_gratis: Boolean(req.body.trial_gratis) });
    }
    res.json({ ok: true });
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Contacto: enviar email a info@wamenu.com.ar
app.post('/api/contact', async (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'Faltan campos' });
    }
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
        const result = await resend.emails.send({
            from,
            to,
            reply_to: email,
            subject: `📩 Contacto: ${name}`,
            html
        });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Contact] Error enviando email:', err);
        res.status(500).json({ error: 'Error al enviar el mensaje' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/suscripcion', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'suscripcion.html'));
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
        const { name, email, dni } = req.body;
        if (!name || !email) {
            return res.status(400).json({ error: 'Faltan nombre o email' });
        }
        const doc = billingService.detectarDocumento(dni);
        if (!doc) {
            return res.status(400).json({ error: 'Ingresá un DNI o CUIT válido. Es necesario para emitir tu Factura C.' });
        }

        const cfg = readConfig();
        const precio = cfg.precio_estandar != null ? cfg.precio_estandar : (process.env.PRECIO_ESTANDAR || '23000');
        const trialPeriodDays = cfg.trial_gratis !== false ? 30 : 0;
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
                notificationUrl: `${siteUrl}/api/mercadopago/webhook`,
                trialPeriodDays
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
                    notificationUrl: `${siteUrl}/api/mercadopago/webhook`,
                    trialPeriodDays
                });
            } else {
                throw mpErr;
            }
        }

        // Guardar referencia del nombre asociado al preapproval (usar email original del formulario)
        const preapprovalRefs = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).preapproval_refs || {};
        preapprovalRefs[preapproval.id] = { name, email, fecha: new Date().toISOString(), docTipo: doc.docTipo, docNro: doc.docNro };
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
                        await asegurarSuscripcion({ preapprovalId: pid, payerEmail: ref.email, payerName: ref.name });
                        await reconciliarCobros(pid);
                        console.log(`[AutoPoll] Preapproval ${pid} procesada vía asegurarSuscripcion`);
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

        // Si no hay referencia, pudo haber sido procesado por el webhook/auto-poll (evitar duplicados)
        const yaProcesado = cfg.pagos_procesados && cfg.pagos_procesados[paymentId];
        if (!ref.email || yaProcesado) {
            if (refs[paymentId]) { delete refs[paymentId]; writeConfig({ preapproval_refs: refs }); }
            if (yaProcesado) return res.redirect(`/suscripcion_exitosa?username=${encodeURIComponent(cfg.pagos_procesados[paymentId].username)}&password=${encodeURIComponent(cfg.pagos_procesados[paymentId].password)}&email=${encodeURIComponent(cfg.pagos_procesados[paymentId].email)}`);
            // El webhook pudo crear el usuario antes que este redirect: mostrar credenciales si ya existe la suscripción
            const sub = await billingService.getSuscripcion(paymentId);
            if (sub && sub.email) {
                const u = await userService.getUserByEmail(sub.email);
                const uname = (u && u.user) || '';
                const passw = (u && u.password) || '';
                const pProc = cfg.pagos_procesados || {};
                pProc[paymentId] = { username: uname, password: passw, email: sub.email };
                writeConfig({ pagos_procesados: pProc });
                return res.redirect(`/suscripcion_exitosa?username=${encodeURIComponent(uname)}&password=${encodeURIComponent(passw)}&email=${encodeURIComponent(sub.email)}`);
            }
            return res.redirect('/');
        }

        if (mpStatus === 'authorized' || mpStatus === 'approved') {
            // Asegurar usuario + suscripción de forma idempotente (compartido con webhook y auto-poll)
            const sub = await asegurarSuscripcion({ preapprovalId: paymentId, payerEmail, payerName });
            if (!sub) {
                console.error(`[Suscripción] No se pudo asegurar la suscripción para ${paymentId}`);
                return res.redirect('/');
            }

            // Disparar facturación de cobros aprobados (en background, no bloquea el redirect)
            reconciliarCobros(paymentId);

            // Recuperar credenciales del usuario (creadas por asegurarSuscripcion)
            const user = await userService.getUserByEmail(payerEmail);
            const username = (user && user.user) || ref.user || '';
            const password = (user && user.password) || '';

            console.log(`[Suscripción] Suscripción asegurada: ${paymentId} (${payerEmail})`);

            // Marcar como procesado y limpiar referencia
            const pagosProc = cfg.pagos_procesados || {};
            pagosProc[paymentId] = { username, password: password, email: payerEmail };
            if (refs[paymentId]) {
                delete refs[paymentId];
                writeConfig({ preapproval_refs: refs, pagos_procesados: pagosProc });
            } else {
                writeConfig({ pagos_procesados: pagosProc });
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
        await billingService.registrarSuscripcion({
            preapprovalId: preapproval_id,
            idCliente,
            nombre: name,
            email: payerEmail,
            docTipo: ref.docTipo || 96,
            docNro: ref.docNro || 0
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

// ─────────────────────────────────────────────────────────────
// Facturación ARCA + ciclo de vida de suscripción
// ─────────────────────────────────────────────────────────────

function pad2(n) {
    return String(n).padStart(2, '0');
}

function toYMD(d) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// Período facturado = mes natural al que pertenece la fecha del cobro
function fmtPeriodo(fechaBase) {
    const d = fechaBase ? new Date(fechaBase) : new Date();
    const desde = new Date(d.getFullYear(), d.getMonth(), 1);
    const hasta = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { desde: toYMD(desde), hasta: toYMD(hasta) };
}

// Lock en memoria por preapproval: serializa la creación de usuario/suscripción
// para que el webhook, el auto-poll y /pago_exitoso no dupliquen el alta.
const processingPreapprovals = new Map();

// Asegura que exista el usuario + suscripción asociados a una preaprobación.
// Es idempotente y tolerante al orden de eventos: el webhook de pago (`payment`)
// puede llegar antes o después que el de `subscription_preapproval`.
async function asegurarSuscripcion({ preapprovalId, payerEmail, payerName }) {
    const key = String(preapprovalId || 'sin-preapproval');
    if (processingPreapprovals.has(key)) {
        return processingPreapprovals.get(key);
    }

    const task = (async () => {
        // 1) Ya registrada en Neon
        let sub = preapprovalId ? await billingService.getSuscripcion(preapprovalId) : null;
        if (sub) return sub;

        // 2) Referencia pendiente en config.json (aún sin procesar por el webhook de preapproval)
        const cfg = readConfig();
        const refs = cfg.preapproval_refs || {};
        const ref = refs[preapprovalId || ''] || {};

        const email = ref.email || payerEmail;
        if (!email) return null;

        // 3) Usuario existente por email (evitar duplicar)
        let user = await userService.getUserByEmail(email);
        if (!user) {
            const username = generateUsername(email);
            const password = generatePassword();
            const idCliente = generateClientId();
            const nombre = ref.name || payerName || 'Cliente';
            try {
                await userService.addUser({
                    idCliente,
                    nombreCliente: nombre,
                    user: username,
                    password,
                    spreadsheetId: process.env.SPREADSHEET_ID,
                    email
                });
                user = { idCliente, nombreCliente: nombre, email };
                try {
                    await emailService.sendWelcomeEmail({ to: email, username, password, name: nombre });
                } catch (emailErr) {
                    console.error('[Webhook] Error enviando email de bienvenida:', emailErr.message);
                }
                console.log(`[Webhook] Usuario creado: ${username} (${email})`);
            } catch (err) {
                // Carrera entre instancias: otro proceso ya creó el usuario con este email
                user = await userService.getUserByEmail(email);
                if (!user) {
                    console.error('[Webhook] Error creando usuario:', err.message);
                    throw err;
                }
                console.log(`[Webhook] Usuario ya existente, se reutiliza: ${user.user} (${email})`);
            }
        }

        await billingService.registrarSuscripcion({
            preapprovalId,
            idCliente: user.idCliente,
            nombre: ref.name || user.nombreCliente || 'Cliente',
            email,
            docTipo: ref.docTipo || 96,
            docNro: ref.docNro || 0
        });

        if (refs[preapprovalId]) {
            delete refs[preapprovalId];
            writeConfig({ preapproval_refs: refs });
        }

        return await billingService.getSuscripcion(preapprovalId);
    })();

    processingPreapprovals.set(key, task);
    try {
        return await task;
    } finally {
        processingPreapprovals.delete(key);
    }
}

async function manejarPreapproval(preapprovalId) {
    console.log(`[Webhook] Recibida preapproval id=${preapprovalId}`);
    const preapproval = await mercadoPagoService.getPreapproval(preapprovalId);
    console.log(`[Webhook] Preapproval ${preapprovalId} status=${preapproval.status}`);
    if (preapproval.status !== 'authorized' && preapproval.status !== 'approved') return;

    const refs = readConfig().preapproval_refs || {};
    const ref = refs[preapprovalId] || {};
    await asegurarSuscripcion({ preapprovalId, payerEmail: ref.email, payerName: ref.name });
    await reconciliarCobros(preapprovalId);
    console.log(`[Webhook] Preapproval ${preapprovalId} procesada OK`);
}

// Reconciliación activa: consulta a MP los cobros de una preaprobación y factura los que
// estén aprobados, aunque el webhook de cobro (subscription_authorized_payment/payment)
// no haya llegado. Idempotente: no refactura un payment_id ya registrado.
async function reconciliarCobros(preapprovalId) {
    if (!preapprovalId) return;
    try {
        const { results = [] } = await mercadoPagoService.searchAuthorizedPayments(preapprovalId);
        for (const item of results) {
            const pago = item.payment || {};
            if (pago.status !== 'approved') continue;
            const paymentId = String(pago.id);
            if (!paymentId) continue;
            const yaFacturado = await billingService.getFacturaByPaymentId(paymentId);
            if (yaFacturado) continue;
            console.log(`[Reconciliación] Cobro aprobado ${paymentId} para preapproval ${preapprovalId} ($${item.transaction_amount}). Facturando...`);
            await procesarPagoAprobado({
                paymentId,
                preapprovalId,
                monto: Number(item.transaction_amount) || 0,
                fechaPago: item.date_created || item.debit_date
            });
        }
    } catch (err) {
        console.error(`[Reconciliación] Error consultando cobros de ${preapprovalId}:`, err.message);
    }
}

async function procesarPagoAprobado({ paymentId, preapprovalId, monto, fechaPago, payerEmail, payerName }) {
    console.log(`[Webhook] Procesando pago aprobado: paymentId=${paymentId} preapprovalId=${preapprovalId} monto=${monto}`);
    // 1) Idempotencia: si este payment_id ya generó factura, no refacturar
    const yaFacturado = await billingService.getFacturaByPaymentId(paymentId);
    if (yaFacturado) {
        console.log(`[Webhook] Pago ${paymentId} ya procesado (Factura N° ${yaFacturado.cbte_nro}).`);
        return yaFacturado;
    }

    // 2) Resolver la suscripción asociada (la crea si hace falta)
    const sub = await asegurarSuscripcion({ preapprovalId, payerEmail, payerName });
    if (!sub) {
        console.error(`[Webhook] Pago ${paymentId} sin suscripción asociada (preapproval ${preapprovalId}).`);
        return null;
    }
    console.log(`[Webhook] Suscripción resuelta: idCliente=${sub.id_cliente} email=${sub.email} tipo=${sub.doc_tipo}-${sub.doc_nro}`);

    const fechaPagoDate = fechaPago ? new Date(fechaPago) : new Date();
    const tipo = sub.fecha_pago ? 'RENOVACION' : 'INICIAL';
    const periodo = fmtPeriodo(fechaPagoDate);
    const montoNum = Number(monto) || 0;
    console.log(`[Webhook] Facturando período ${periodo.desde} a ${periodo.hasta} (${tipo}) por $${montoNum}`);

    // 3) Emitir Factura C en ARCA
    let facturaArca = null;
    if (arcaService.isConfigured()) {
        console.log(`[ARCA] Iniciando emisión Factura C: docTipo=${sub.doc_tipo} docNro=${sub.doc_nro} monto=${montoNum}`);
        try {
            facturaArca = await arcaService.emitirFacturaC({
                docTipo: sub.doc_tipo || 96,
                docNro: sub.doc_nro || 0,
                monto: montoNum,
                periodoDesde: periodo.desde,
                periodoHasta: periodo.hasta
            });
            console.log(`[ARCA] Factura C emitida OK: ${facturaArca.ptoVta}-${facturaArca.cbteNro} CAE=${facturaArca.cae}`);
        } catch (arcaErr) {
            // No se registra la factura: el próximo reintento del webhook volverá a intentarlo
            console.error('[Webhook] Error emitiendo Factura C:', arcaErr.message);
            return null;
        }
    } else {
        console.warn('[Webhook] ARCA no configurado, omitiendo emisión de Factura C.');
        return null;
    }

    // 4) Registrar factura (idempotente por payment_id)
    const registrada = await billingService.registrarFactura({
        paymentId,
        preapprovalId: sub.preapproval_id,
        idCliente: sub.id_cliente,
        tipo,
        factura: facturaArca,
        monto: montoNum,
        periodoDesde: periodo.desde,
        periodoHasta: periodo.hasta
    });
    if (!registrada) return null;
    console.log(`[Webhook] Factura registrada en BD: id=${registrada.id || registrada}`);

    // 5) Renovar: fecha de cobro + vencimiento (+1 mes)
    await billingService.renovarSuscripcion(sub.preapproval_id, { fechaPago: fechaPagoDate });

    // 6) Email de confirmación + datos fiscales
    try {
        await emailService.sendInvoiceEmail({
            to: sub.email,
            name: sub.nombre_cliente || 'Cliente',
            email: sub.email,
            factura: facturaArca,
            monto: montoNum,
            periodoDesde: periodo.desde,
            periodoHasta: periodo.hasta,
            esRenovacion: tipo === 'RENOVACION'
        });
    } catch (emailErr) {
        console.error('[Webhook] Error enviando factura por email:', emailErr.message);
    }

    console.log(`[Webhook] Pago ${paymentId} procesado: Factura ${facturaArca.ptoVta}-${facturaArca.cbteNro} CAE ${facturaArca.cae} (${tipo})`);
    return registrada;
}

async function manejarAuthorizedPayment(id) {
    console.log(`[Webhook] Cobro autorizado id=${id}`);
    const pa = await mercadoPagoService.getAuthorizedPayment(id);
    console.log(`[Webhook] AuthorizedPayment ${id} status=${pa.status}`);
    if (pa.status !== 'approved') return;
    const payer = pa.payer || (pa.card && pa.card.payer) || {};
    const payerName = [payer.first_name, payer.last_name].filter(Boolean).join(' ') || null;
    const payerEmail = pa.payer_email || payer.email;
    await procesarPagoAprobado({
        paymentId: pa.payment_id || pa.id,
        preapprovalId: pa.preapproval_id,
        monto: pa.transaction_amount,
        fechaPago: pa.date_created || pa.date_approved,
        payerEmail,
        payerName
    });
}

async function manejarPayment(id) {
    console.log(`[Webhook] Payment id=${id}`);
    const p = await mercadoPagoService.getPayment(id);
    console.log(`[Webhook] Payment ${id} status=${p.status}`);
    if (p.status !== 'approved') return;
    const payer = p.payer || {};
    const payerName = [payer.first_name, payer.last_name].filter(Boolean).join(' ') || null;
    await procesarPagoAprobado({
        paymentId: p.id,
        preapprovalId: p.preapproval_id,
        monto: p.transaction_amount,
        fechaPago: p.date_approved || p.date_created,
        payerEmail: payer.email,
        payerName
    });
}

// MercadoPago: IPN Webhook
app.post('/api/mercadopago/webhook', async (req, res) => {
    console.log('[MercadoPago Webhook] Received:', JSON.stringify(req.body));
    res.sendStatus(200);

    const { type, action, data } = req.body || {};
    if (!data || !data.id) {
        console.log('[Webhook] Sin data.id, ignorado.');
        return;
    }
    console.log(`[Webhook] Evento: type=${type} action=${action} data.id=${data.id}`);

    // Procesamiento asincrónico (MP espera 200 inmediato)
    (async () => {
        try {
            if (type === 'subscription_preapproval') {
                await manejarPreapproval(data.id);
            } else if (type === 'subscription_authorized_payment') {
                await manejarAuthorizedPayment(data.id);
            } else if (type === 'payment') {
                await manejarPayment(data.id);
            } else {
                console.log(`[Webhook] Tipo no manejado: ${type} (action: ${action})`);
            }
        } catch (err) {
            console.error('[Webhook] Error processing:', err);
        }
    })();
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

// Endpoint admin: re-procesa los cobros aprobados de una preaprobación (webhooks perdidos).
// Requiere header x-admin-key == RECONCILE_API_KEY.
app.post('/api/mercadopago/reconciliar', async (req, res) => {
    const key = process.env.RECONCILE_API_KEY;
    if (!key || req.get('x-admin-key') !== key) {
        return res.status(403).json({ error: 'No autorizado' });
    }
    const { preapproval_id } = req.body || {};
    if (!preapproval_id) return res.status(400).json({ error: 'Falta preapproval_id' });
    try {
        await reconciliarCobros(preapproval_id);
        res.json({ ok: true, preapproval_id });
    } catch (err) {
        console.error('[Reconciliación] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint admin: verifica localmente (sin llamar a AFIP) cómo llegan el cert y la key.
app.get('/api/arca/check', (req, res) => {
    const report = arcaService.diagnoseCerts();
    console.log('[ARCA] Diagnóstico de certificados:');
    report.checks.forEach((c) => console.log(`[ARCA]   - ${c.name}: ${c.ok ? 'OK' : 'FALLO'} | ${c.detail}`));
    res.json(report);
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
