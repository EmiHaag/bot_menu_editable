require('dotenv').config();
// Also try loading .env from parent directory (for monorepo local dev)
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const express = require('express');
const bodyParser = require('body-parser');
const GoogleSheetsService = require('../services/googleSheetsService');
const userService = require('../services/userService');
const {
    google
} = require('googleapis');

const GoogleDriveService = require('../services/googleDriveService');
const orderService = require('../services/orderService');
const botConfigService = require('../services/botConfigService');
const calendarService = require('../services/googleCalendarService');
const logService = require('../services/logService');
const { helpGuideCSS, helpGuideHTML, helpGuideJS } = require('./helpGuide');
const { askGemini } = require('./geminiHelper');
const { icon } = require('./icons');
const billingService = require('../services/billingService');

function parseHorariosJson(str) {
    try {
        const obj = str ? JSON.parse(str) : {};
        return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
        return {};
    }
}

class Dashboard {
    constructor() {
        this.services = {};
    }

    async initService(botId, spreadsheetId) {
        // Si no se provee spreadsheetId, intentamos obtenerlo del usuario
        if (!spreadsheetId) {
            const user = await userService.getUsers().then(users => users.find(u => u.idCliente === botId));
            spreadsheetId = user ? user.spreadsheetId : process.env.SPREADSHEET_ID;
        }

        const cacheKey = `${botId}_${spreadsheetId}`;
        if (!this.services[cacheKey]) {
            this.services[cacheKey] = new GoogleSheetsService({
                clientId: botId,
                spreadsheetId: spreadsheetId,
                credentials: process.env.CREDENTIALS_JSON
            });
        }
        return this.services[cacheKey];
    }

    setupRoutes() {
        const router = express.Router();

        router.use(bodyParser.urlencoded({
            extended: true
        }));
        router.use(bodyParser.json());

        // Middleware to get the correct service based on logged user and query param
        const getServiceInfo = async (req) => {
            const loggedUser = req.user;
            let botId = req.query.botId || (req.body && req.body.botId);

            // Si no es admin, forzar su propio botId
            if (loggedUser.idCliente !== 'admin') {
                botId = loggedUser.idCliente;
                const service = await this.initService(botId, loggedUser.spreadsheetId);
                return { service, botId, isAdmin: false };
            } else {
                // Es admin
                if (!botId) {
                    const activeClients = await userService.getActiveClients();
                    botId = activeClients.length > 0 ? activeClients[0].idCliente : 'default';
                }
                
                const allUsers = await userService.getUsers();
                const targetUser = allUsers.find(u => u.idCliente === botId);
                const service = await this.initService(botId, targetUser ? targetUser.spreadsheetId : process.env.SPREADSHEET_ID);
                return {
                    service,
                    botId,
                    isAdmin: true
                };
            }
        };

        // --- RUTAS DE ADMINISTRACIÓN DE CLIENTES ---
        
        router.get('/admin', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).send('Acceso denegado');
            
            try {
                const clients = await userService.getUsers();
                const filteredClients = clients.filter(c => c.idCliente !== 'admin');
                
                let rowsHtml = filteredClients.map(client => `
                    <tr>
                        <td>${client.idCliente}</td>
                        <td>${client.nombreCliente}</td>
                        <td>${client.user}</td>
                        <td>${client.activo ? '<span style="color: green">Activo</span>' : '<span style="color: red">Inactivo</span>'}</td>
                        <td>${client.plan === 'premium' ? '<span style="display:inline-block;padding:2px 10px;border-radius:12px;background:#ecfdf5;color:#059669;font-weight:700;font-size:11px;">Premium</span>' : '<span style="display:inline-block;padding:2px 10px;border-radius:12px;background:#f1f5f9;color:#64748b;font-weight:600;font-size:11px;">Estándar</span>'}</td>
                        <td><small>${client.spreadsheetId}</small></td>
                        <td style="white-space:nowrap;">
                            <a href="/app/?botId=${client.idCliente}" class="btn-action btn-action-blue" title="Ver Menú">${icon('eye', 'w-4 h-4 inline')} Menú</a>
                            <a href="/app/pedidos/${client.idCliente}" target="_blank" class="btn-action btn-action-green" title="Ver Pedidos">${icon('documentText', 'w-4 h-4 inline')} Pedidos</a>
                            <button onclick="openPlanModal('${client.idCliente}', '${client.plan === 'premium' ? 'premium' : 'estandar'}')" class="btn-action btn-action-blue" title="Cambiar plan">${icon('cog6Tooth', 'w-4 h-4 inline')} Plan</button>
                            <button onclick="deleteClient('${client.idCliente}')" class="btn-action btn-action-red" title="Borrar cliente">${icon('xCircle', 'w-4 h-4 inline')} Borrar</button>
                        </td>
                    </tr>
                `).join('');

                res.send(`
                    <html>
                    <head>
                        <title>Panel de Administración - Bots</title>
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <style>
                            :root {
                                --primary-color: #00bc7d;
                                --bg-white: #ffffff;
                                --bg-box: #fbfbfb;
                                --border-color: #e7e3e4;
                                --text-main: #333;
                                --error-color: #dc3545;
                            }
                            body { font-family: 'Segoe UI', sans-serif; margin: 40px; background: var(--bg-white); }
                            .header { display: flex; flex-wrap: wrap; margin-right: -15px; margin-left: -15px; }
                            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                            th, td { padding: 12px; border: 1px solid var(--border-color); text-align: left; }
                            th { background: var(--bg-box); }
                            .btn { padding: 10px 18px; text-decoration: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: all .15s ease; display: inline-flex; align-items: center; gap: 6px; }
                            .btn:hover { opacity: .85; }
                            .btn-green { background: var(--primary-color); color: white; border: none; }
                            .btn-outline { background: white; color: #555; border: 1px solid var(--border-color); }
                            .btn-outline:hover { background: #f5f5f5; }
                            .btn-action { padding: 5px 10px; border-radius: 5px; text-decoration: none; border: 1px solid; font-size: 12px; font-weight: 500; cursor: pointer; transition: all .15s ease; display: inline-flex; align-items: center; gap: 4px; }
                            .btn-action:hover { opacity: .8; }
                            .btn-action-blue { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
                            .btn-action-green { background: #ecfdf5; color: #059669; border-color: #a7f3d0; }
                            .btn-action-red { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
                            .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); }
                            .modal-content { background: white; margin: 10% auto; padding: 30px; width: 400px; border-radius: 12px; }
                            .form-group { margin-bottom: 15px; }
                            .form-group label { display: block; margin-bottom: 5px; font-weight: bold; }
                            .form-group input { width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box; }
                        @media (max-width: 768px) {
                            body { margin: 16px; }
                            .header { flex-direction: column; align-items: stretch; gap: 12px; }
                            .header > div { justify-content: center; }
                            .header .btn { width: 100%; text-align: center; box-sizing: border-box; }
                            .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
                            table { font-size: 12px; min-width: 600px; }
                            th, td { padding: 8px 6px; white-space: nowrap; }
                            .modal-content { width: 95% !important; margin: 5% auto; padding: 20px; box-sizing: border-box; }
                            .form-group input { font-size: 16px; }
                        }
                        </style>
                    </head>
                    <body>
                        <div class="header">
                            <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
                                <a href="/" style="display:block;"><img src="/img/wamenu_logo_name.png" alt="WaMenu" style="width:100%;max-width:8em;height:auto;object-fit:contain;"></a>
                                <h2>Administración de Clientes</h2>
                            </div>
                            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                <button onclick="document.getElementById('addClientModal').style.display='block'" class="btn btn-green">${icon('plus', 'w-4 h-4 inline')} Nuevo Cliente</button>
                                <a href="/app/admin/logs" class="btn btn-outline">${icon('clipboardDocumentList', 'w-4 h-4 inline')} Logs</a>
                                <a href="/app/admin/events" class="btn btn-outline">${icon('user', 'w-4 h-4 inline')} Eventos</a>
                                <a href="/app/" class="btn btn-outline">${icon('arrowLeft', 'w-4 h-4 inline')} Editor</a>
                            </div>
                        </div>

                        <div class="table-wrap">
                        <table>
                            <thead>
                                <tr>
                                    <th>ID Cliente</th>
                                    <th>Nombre</th>
                                    <th>Usuario</th>
                                    <th>Estado</th>
                                    <th>Plan</th>
                                    <th>Spreadsheet ID</th>
                                    <th>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHtml}
                            </tbody>
                        </table>
                        </div>

                            <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e7e3e4;">
                            <h3>${icon('cog6Tooth', 'w-4 h-4 inline')} Configuración General</h3>
                            <div style="display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap;">
                                <label style="font-weight: 600;">Precio Plan Estándar ($):</label>
                                <input type="number" id="precioInput" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; width: 120px; font-size: 1rem;">
                                <button onclick="savePrice()" class="btn btn-green">Guardar</button>
                                <span id="priceStatus" style="font-size: 0.85rem; color: #888;"></span>
                            </div>
                        </div>

                        <div id="addClientModal" class="modal">
                            <div class="modal-content">
                                <h3>Crear Nuevo Cliente</h3>
                                <form action="/app/admin/create-client" method="POST">
                                    <div class="form-group">
                                        <label>ID Cliente (ej: pizzeriajuan):</label>
                                        <input type="text" name="idCliente" required>
                                    </div>
                                    <div class="form-group">
                                        <label>Nombre del Negocio:</label>
                                        <input type="text" name="nombreCliente" required>
                                    </div>
                                    <div class="form-group">
                                        <label>Usuario Login:</label>
                                        <input type="text" name="user" required>
                                    </div>
                                    <div class="form-group">
                                        <label>Contraseña Login:</label>
                                        <input type="password" name="password" required>
                                    </div>
                                    <div style="display: flex; gap: 10px;">
                                        <button type="submit" class="btn btn-green" style="flex: 1">Crear</button>
                                        <button type="button" onclick="document.getElementById('addClientModal').style.display='none'" class="btn" style="flex: 1; border: 1px solid #ccc">Cancelar</button>
                                    </div>
                                </form>
                            </div>
                        </div>

                        <div id="planModal" class="modal">
                            <div class="modal-content">
                                <h3>Cambiar Plan del Cliente</h3>
                                <form action="/app/admin/update-plan" method="POST">
                                    <div class="form-group">
                                        <label>ID Cliente:</label>
                                        <input type="text" id="planClientId" name="idCliente" readonly>
                                    </div>
                                    <div class="form-group">
                                        <label>Plan:</label>
                                        <select id="planSelect" name="plan" style="width:100%;padding:10px;border:1px solid var(--border-color);border-radius:6px;">
                                            <option value="estandar">Estándar</option>
                                            <option value="premium">Premium</option>
                                        </select>
                                    </div>
                                    <div style="display: flex; gap: 10px;">
                                        <button type="submit" class="btn btn-green" style="flex: 1">Guardar</button>
                                        <button type="button" onclick="document.getElementById('planModal').style.display='none'" class="btn" style="flex: 1; border: 1px solid #ccc">Cancelar</button>
                                    </div>
                                </form>
                            </div>
                        </div>

                        <script>
                            fetch('/api/config').then(function(r){return r.json()}).then(function(d){
                                document.getElementById('precioInput').value = d.precioEstandar;
                            });
                            function savePrice() {
                                var val = document.getElementById('precioInput').value;
                                var payload = {};
                                if (val) payload.precio_estandar = Number(val);
                                fetch('/api/config', {
                                    method: 'POST',
                                    headers: {'Content-Type': 'application/json'},
                                    body: JSON.stringify(payload)
                                }).then(function(r){return r.json()}).then(function(){
                                    document.getElementById('priceStatus').innerHTML = '${icon('checkCircle', 'w-4 h-4 inline text-green-400')} Guardado';
                                    setTimeout(function(){document.getElementById('priceStatus').textContent = '';}, 3000);
                                });
                            }
                            function openPlanModal(id, plan) {
                                document.getElementById('planClientId').value = id;
                                document.getElementById('planSelect').value = plan;
                                document.getElementById('planModal').style.display = 'block';
                            }
                            function deleteClient(id) {
                                if (confirm('¿Seguro que deseas borrar al cliente ' + id + '? Se eliminará su acceso.')) {
                                    window.location.href = '/app/admin/delete-client/' + id;
                                }
                            }
                        </script>
                    </body>
                    </html>
                `);
            } catch (error) {
                console.error('Error admin panel:', error);
                res.status(500).send('Error loading admin panel');
            }
        });

        router.post('/admin/create-client', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).send('Acceso denegado');
            const { idCliente, nombreCliente, user, password } = req.body;

            try {
                // 1. Obtener o crear carpeta 'bots'
                const folderId = await GoogleDriveService.getOrCreateFolder('bots');

                // 2. Crear Spreadsheet para el cliente con sus datos de login
                const spreadsheetId = await GoogleDriveService.createClientSpreadsheet({
                    idCliente,
                    nombreCliente,
                    user,
                    password
                }, folderId);

                // 3. Crear Spreadsheet de Pedidos para el cliente
                await orderService.createPedidosSpreadsheet(idCliente);

                // 4. Agregar a la lista de usuarios maestra
                await userService.addUser({
                    idCliente,
                    nombreCliente,
                    user,
                    password,
                    spreadsheetId
                });

                res.redirect('/app/admin?success=1');
            } catch (error) {
                console.error('Error creating client:', error);
                res.status(500).send('Error al crear el cliente: ' + error.message);
            }
        });

        router.get('/admin/delete-client/:id', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).send('Acceso denegado');
            const id = req.params.id;

            try {
                // Obtener datos del usuario antes de borrarlo para tener su spreadsheetId
                const users = await userService.getUsers();
                const client = users.find(u => u.idCliente === id);
                
                // 1. Borrar de la lista de usuarios maestra
                await userService.deleteUser(id);

                // 2. Borrar suscripción y facturas
                await billingService.deleteSuscripcionByIdCliente(id);

                // 3. Si tenía un spreadsheet propio, mandarlo a la papelera
                if (client && client.spreadsheetId && client.spreadsheetId !== process.env.SPREADSHEET_ID) {
                    await GoogleDriveService.deleteFile(client.spreadsheetId);
                }

                // 3. Borrar spreadsheet de Pedidos
                await orderService.deletePedidosSpreadsheet(id);

                res.redirect('/app/admin?deleted=1');
            } catch (error) {
                console.error('Error deleting client:', error);
                res.status(500).send('Error al borrar el cliente');
            }
        });

        router.post('/admin/update-plan', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).send('Acceso denegado');
            const { idCliente, plan } = req.body;
            if (!idCliente) return res.status(400).send('Falta idCliente');

            try {
                await userService.updatePlan(idCliente, plan);
                res.redirect('/app/admin?planUpdated=1');
            } catch (error) {
                console.error('Error updating plan:', error);
                res.status(500).send('Error al actualizar el plan');
            }
        });

        // Ruta para abrir la hoja de pedidos de un cliente
        router.get('/pedidos/:clientId', async (req, res) => {
            try {
                let sheetId = await orderService.getPedidosSpreadsheetId(req.params.clientId);
                if (!sheetId) {
                    sheetId = await orderService.createPedidosSpreadsheet(req.params.clientId);
                }
                if (sheetId) {
                    return res.redirect(`https://docs.google.com/spreadsheets/d/${sheetId}`);
                }
                res.status(500).send('No se pudo crear la hoja de pedidos.');
            } catch (error) {
                console.error('Error al obtener hoja de pedidos:', error);
                res.status(500).send('Error al obtener la hoja de pedidos.');
            }
        });

        // --- VISOR DE LOGS (Solo admin) ---
        const adminViewerStyle = `
            <style>
                body { font-family: 'Segoe UI', sans-serif; margin: 24px; background: #fafafa; }
                .topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
                .topbar h2 { margin: 0; }
                .filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: #fff; border: 1px solid #e7e3e4; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; }
                .filters select, .filters input { padding: 6px 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 13px; }
                .filters .btn { padding: 7px 14px; border: none; border-radius: 6px; background: #0f6b4f; color: #fff; cursor: pointer; font-size: 13px; font-weight: 600; }
                table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e7e3e4; border-radius: 10px; overflow: hidden; }
                th, td { padding: 9px 10px; border-bottom: 1px solid #f0eeee; text-align: left; vertical-align: top; }
                th { background: #f5f5f5; font-size: 12px; text-transform: uppercase; letter-spacing: 0.4px; color: #555; }
                td { font-size: 13px; }
                .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
                .badge-info { background: #e0f2fe; color: #0369a1; }
                .badge-warning { background: #fef3c7; color: #92400e; }
                .badge-error { background: #fee2e2; color: #b91c1c; }
                .msg { max-width: 520px; word-break: break-word; font-family: Consolas, monospace; font-size: 12px; color: #333; }
                .meta { max-width: 320px; word-break: break-word; font-family: Consolas, monospace; font-size: 11px; color: #888; }
                .user { font-weight: 600; color: #0f6b4f; }
                .time { white-space: nowrap; color: #666; font-size: 12px; }
                .empty { text-align: center; padding: 30px; color: #888; }
                .back { text-decoration: none; color: #0f6b4f; font-weight: 600; font-size: 13px; }
            </style>
        `;
        const adminViewerJs = `
            <script src="/js/robot-logo.js"></script>
            <script>
                function drawPage() {
                    if (window.__drawDone) return;
                    window.__drawDone = true;
                    var c = document.getElementById('logo');
                    if (c && window.drawRobot) drawRobot('logo');
                }
                drawPage();
            </script>
        `;

        router.get('/admin/logs', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).send('Acceso denegado');
            res.send(`
                <html>
                <head>
                    <title>Visor de Logs - Administración</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    ${adminViewerStyle}
                </head>
                <body>
                    <div class="topbar">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <canvas id="logo" width="200" height="200" style="width:44px; height:44px;"></canvas>
                            <h2>${icon('clipboardDocumentList', 'w-4 h-4 inline')} Visor de Logs del Sistema</h2>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <a href="/app/admin/events" class="btn" style="padding:8px 14px; border:1px solid #ccc; border-radius:6px; text-decoration:none; color:#333; font-size:13px;">${icon('user', 'w-4 h-4 inline')} Eventos de Usuarios</a>
                            <a href="/app/admin" class="btn" style="padding:8px 14px; border:1px solid #ccc; border-radius:6px; text-decoration:none; color:#333; font-size:13px;">${icon('arrowLeft', 'w-4 h-4 inline')} Volver al Panel</a>
                        </div>
                    </div>

                    <div class="filters">
                        <select id="fLevel">
                            <option value="">Todas las criticidades</option>
                            <option value="info">Info</option>
                            <option value="warning">Warning</option>
                            <option value="error">Error</option>
                        </select>
                        <select id="fCategory">
                            <option value="">Todas las categorías</option>
                            <option value="system">system</option>
                            <option value="bot">bot</option>
                            <option value="auth">auth</option>
                            <option value="billing">billing</option>
                            <option value="suscripcion">suscripcion</option>
                            <option value="console">console</option>
                        </select>
                        <select id="fUser"><option value="">Todos los usuarios</option></select>
                        <input type="text" id="fSearch" placeholder="Buscar en mensaje / usuario / categoría..." style="flex:1; min-width:200px;">
                        <button class="btn" onclick="loadLogs()">Filtrar</button>
                        <span id="countLabel" style="font-size:12px; color:#888;"></span>
                    </div>

                    <div style="overflow-x:auto;">
                    <table>
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Criticidad</th>
                                <th>Categoría</th>
                                <th>Usuario</th>
                                <th>Mensaje</th>
                                <th>Detalle</th>
                            </tr>
                        </thead>
                        <tbody id="logsBody">
                            <tr><td colspan="6" class="empty">Cargando logs...</td></tr>
                        </tbody>
                    </table>
                    </div>

                    <script>
                        var autoTimer = null;
                        function fmtTime(iso) {
                            if (!iso) return '-';
                            var d = new Date(iso);
                            if (isNaN(d.getTime())) return iso;
                            return d.toLocaleDateString('es-AR') + ' ' + d.toLocaleTimeString('es-AR');
                        }
                        function badge(level) {
                            var cls = level === 'error' ? 'badge-error' : level === 'warning' ? 'badge-warning' : 'badge-info';
                            var txt = (level === 'warning' ? 'warning' : level) || 'info';
                            return '<span class="badge ' + cls + '">' + txt + '</span>';
                        }
                        function metaHtml(m) {
                            if (!m) return '—';
                            try {
                                var s = typeof m === 'string' ? m : JSON.stringify(m);
                                return '<span class="meta">' + s.slice(0, 400) + '</span>';
                            } catch(e) { return '—'; }
                        }
                        function escapeHtml(s) {
                            return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
                                return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
                            });
                        }
                        function loadLogs() {
                            var params = new URLSearchParams();
                            var level = document.getElementById('fLevel').value;
                            var category = document.getElementById('fCategory').value;
                            var user = document.getElementById('fUser').value;
                            var search = document.getElementById('fSearch').value.trim();
                            if (level) params.set('level', level);
                            if (category) params.set('category', category);
                            if (user) params.set('userId', user);
                            if (search) params.set('search', search);
                            fetch('/api/admin/logs?' + params.toString())
                                .then(function(r) { return r.json(); })
                                .then(function(data) {
                                    if (data.users && document.getElementById('fUser').options.length <= 1) {
                                        var sel = document.getElementById('fUser');
                                        data.users.forEach(function(u) {
                                            var o = document.createElement('option');
                                            o.value = u; o.textContent = u;
                                            sel.appendChild(o);
                                        });
                                    }
                                    var tbody = document.getElementById('logsBody');
                                    document.getElementById('countLabel').textContent = data.logs.length + ' registro(s)';
                                    if (!data.logs.length) {
                                        tbody.innerHTML = '<tr><td colspan="6" class="empty">No se encontraron logs con los filtros aplicados.</td></tr>';
                                        return;
                                    }
                                    tbody.innerHTML = data.logs.map(function(l) {
                                        return '<tr>' +
                                            '<td class="time">' + fmtTime(l.created_at) + '</td>' +
                                            '<td>' + badge(l.level) + '</td>' +
                                            '<td>' + escapeHtml(l.category) + '</td>' +
                                            '<td class="user">' + (l.user_id ? escapeHtml(l.user_id) : '—') + '</td>' +
                                            '<td class="msg">' + escapeHtml(l.message) + '</td>' +
                                            '<td>' + metaHtml(l.meta) + '</td>' +
                                            '</tr>';
                                    }).join('');
                                })
                                .catch(function(err) {
                                    document.getElementById('logsBody').innerHTML = '<tr><td colspan="6" class="empty">Error cargando logs (¿sesión expirada?).</td></tr>';
                                });
                        }
                        document.getElementById('fSearch').addEventListener('keydown', function(e) { if (e.key === 'Enter') loadLogs(); });
                        document.getElementById('fLevel').addEventListener('change', loadLogs);
                        document.getElementById('fCategory').addEventListener('change', loadLogs);
                        document.getElementById('fUser').addEventListener('change', loadLogs);
                        var visible = true;
                        document.addEventListener('visibilitychange', function() {
                            visible = !document.hidden;
                            if (visible) { loadLogs(); clearInterval(autoTimer); autoTimer = setInterval(loadLogs, 10000); }
                        });
                        loadLogs();
                        autoTimer = setInterval(loadLogs, 10000);
                    </script>
                    ${adminViewerJs}
                </body>
                </html>
            `);
        });

        router.get('/admin/events', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).send('Acceso denegado');
            res.send(`
                <html>
                <head>
                    <title>Eventos de Usuarios - Administración</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    ${adminViewerStyle}
                </head>
                <body>
                    <div class="topbar">
                        <div style="display:flex; align-items:center; gap:12px;">
                            <canvas id="logo" width="200" height="200" style="width:44px; height:44px;"></canvas>
                            <h2>${icon('user', 'w-4 h-4 inline')} Visor de Eventos del Dashboard</h2>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <a href="/app/admin/logs" class="btn" style="padding:8px 14px; border:1px solid #ccc; border-radius:6px; text-decoration:none; color:#333; font-size:13px;">${icon('clipboardDocumentList', 'w-4 h-4 inline')} Logs del Sistema</a>
                            <a href="/app/admin" class="btn" style="padding:8px 14px; border:1px solid #ccc; border-radius:6px; text-decoration:none; color:#333; font-size:13px;">${icon('arrowLeft', 'w-4 h-4 inline')} Volver al Panel</a>
                        </div>
                    </div>

                    <div class="filters">
                        <select id="fUser"><option value="">Todos los usuarios</option></select>
                        <select id="fAction"><option value="">Todas las acciones</option></select>
                        <input type="text" id="fSearch" placeholder="Buscar en mensaje / entidad / usuario..." style="flex:1; min-width:200px;">
                        <button class="btn" onclick="loadEvents()">Filtrar</button>
                        <span id="countLabel" style="font-size:12px; color:#888;"></span>
                    </div>

                    <div style="overflow-x:auto;">
                    <table>
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Usuario</th>
                                <th>Acción</th>
                                <th>Entidad</th>
                                <th>Mensaje</th>
                                <th>IP</th>
                            </tr>
                        </thead>
                        <tbody id="eventsBody">
                            <tr><td colspan="6" class="empty">Cargando eventos...</td></tr>
                        </tbody>
                    </table>
                    </div>

                    <script>
                        var autoTimer = null;
                        function fmtTime(iso) {
                            if (!iso) return '-';
                            var d = new Date(iso);
                            if (isNaN(d.getTime())) return iso;
                            return d.toLocaleDateString('es-AR') + ' ' + d.toLocaleTimeString('es-AR');
                        }
                        function escapeHtml(s) {
                            return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
                                return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
                            });
                        }
                        function loadEvents() {
                            var params = new URLSearchParams();
                            var user = document.getElementById('fUser').value;
                            var action = document.getElementById('fAction').value;
                            var search = document.getElementById('fSearch').value.trim();
                            if (user) params.set('userId', user);
                            if (action) params.set('action', action);
                            if (search) params.set('search', search);
                            fetch('/api/admin/events?' + params.toString())
                                .then(function(r) { return r.json(); })
                                .then(function(data) {
                                    if (data.users && document.getElementById('fUser').options.length <= 1) {
                                        var sel = document.getElementById('fUser');
                                        data.users.forEach(function(u) {
                                            var o = document.createElement('option');
                                            o.value = u; o.textContent = u;
                                            sel.appendChild(o);
                                        });
                                    }
                                    if (data.actions && document.getElementById('fAction').options.length <= 1) {
                                        var selA = document.getElementById('fAction');
                                        data.actions.forEach(function(a) {
                                            var o = document.createElement('option');
                                            o.value = a; o.textContent = a;
                                            selA.appendChild(o);
                                        });
                                    }
                                    var tbody = document.getElementById('eventsBody');
                                    document.getElementById('countLabel').textContent = data.events.length + ' evento(s)';
                                    if (!data.events.length) {
                                        tbody.innerHTML = '<tr><td colspan="6" class="empty">No se encontraron eventos con los filtros aplicados.</td></tr>';
                                        return;
                                    }
                                    tbody.innerHTML = data.events.map(function(e) {
                                        return '<tr>' +
                                            '<td class="time">' + fmtTime(e.created_at) + '</td>' +
                                            '<td class="user">' + escapeHtml(e.user_id) + '</td>' +
                                            '<td><span class="badge badge-info">' + escapeHtml(e.action) + '</span></td>' +
                                            '<td>' + (e.entity ? escapeHtml(e.entity) : '—') + '</td>' +
                                            '<td class="msg">' + escapeHtml(e.message) + '</td>' +
                                            '<td>' + (e.ip ? escapeHtml(e.ip) : '—') + '</td>' +
                                            '</tr>';
                                    }).join('');
                                })
                                .catch(function(err) {
                                    document.getElementById('eventsBody').innerHTML = '<tr><td colspan="6" class="empty">Error cargando eventos (¿sesión expirada?).</td></tr>';
                                });
                        }
                        document.getElementById('fSearch').addEventListener('keydown', function(e) { if (e.key === 'Enter') loadEvents(); });
                        document.getElementById('fUser').addEventListener('change', loadEvents);
                        document.getElementById('fAction').addEventListener('change', loadEvents);
                        var visible = true;
                        document.addEventListener('visibilitychange', function() {
                            visible = !document.hidden;
                            if (visible) { loadEvents(); clearInterval(autoTimer); autoTimer = setInterval(loadEvents, 10000); }
                        });
                        loadEvents();
                        autoTimer = setInterval(loadEvents, 10000);
                    </script>
                    ${adminViewerJs}
                </body>
                </html>
            `);
        });

        // --- FIN RUTAS ADMINISTRACIÓN ---

        // API: Obtener logs del sistema (solo admin)
        router.get('/api/admin/logs', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
            try {
                const { level, category, userId, search, limit, offset } = req.query;
                const logs = await logService.getLogs({
                    level: level || '',
                    category: category || '',
                    userId: userId || '',
                    search: search || '',
                    limit: Math.min(Number(limit) || 200, 500),
                    offset: Number(offset) || 0
                });
                const users = await logService.getLogUsers();
                res.json({ logs, users });
            } catch (err) {
                res.status(500).json({ error: 'Error obteniendo logs' });
            }
        });

        // API: Obtener eventos de usuarios (solo admin)
        router.get('/api/admin/events', async (req, res) => {
            if (req.user.idCliente !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
            try {
                const { userId, action, search, limit, offset } = req.query;
                const events = await logService.getEvents({
                    userId: userId || '',
                    action: action || '',
                    search: search || '',
                    limit: Math.min(Number(limit) || 200, 500),
                    offset: Number(offset) || 0
                });
                const users = await logService.getEventUsers();
                const actions = await logService.getEventActions();
                res.json({ events, users, actions });
            } catch (err) {
                res.status(500).json({ error: 'Error obteniendo eventos' });
            }
        });

        // Ruta para guardar horarios de atención de un cliente
        router.post('/api/schedule', async (req, res) => {
            try {
                const loggedUser = req.user;
                const botId = req.body.botId || loggedUser.idCliente;
                if (loggedUser.idCliente !== 'admin' && botId !== loggedUser.idCliente) {
                    return res.status(403).json({ error: 'Unauthorized' });
                }

                const online24_7 = !!req.body.online_24_7;
                let horarios = '';
                if (req.body.horarios && typeof req.body.horarios === 'object') {
                    const clean = {};
                    for (const [k, v] of Object.entries(req.body.horarios)) {
                        if (!/^[0-6]$/.test(k) || !Array.isArray(v)) continue;
                        clean[k] = v
                            .filter(r => r && r.desde && r.hasta)
                            .map(r => ({ desde: String(r.desde).slice(0, 5), hasta: String(r.hasta).slice(0, 5) }));
                    }
                    horarios = JSON.stringify(clean);
                }

                const ok = await userService.updateHorarios(botId, online24_7, horarios);
                if (!ok) return res.status(500).json({ error: 'No se pudo guardar' });
                res.json({ success: true });
            } catch (error) {
                console.error('Error saving schedule:', error);
                res.status(500).json({ error: 'Error al guardar' });
            }
        });

        // Ruta para refrescar caché
        router.get('/refresh', async (req, res) => {
            try {
                const {
                    service,
                    botId
                } = await getServiceInfo(req);
                if (service) service.clearCache();
                res.redirect(`/app/?botId=${encodeURIComponent(botId)}`);
            } catch (error) {
                console.error('Error al refrescar:', error);
                res.status(500).send('Error al refrescar la caché.');
            }
        });

        // ─── Configuración de tipo de bot + Google Calendar ───

        const getBotIdFromReq = (req) => {
            const loggedUser = req.user;
            const botId = (req.body && req.body.botId) || (req.query && req.query.botId) || loggedUser.idCliente;
            return botId;
        };

        const assertBotAccess = (req, botId) => {
            const loggedUser = req.user;
            if (loggedUser.idCliente !== 'admin' && botId !== loggedUser.idCliente) {
                return false;
            }
            return true;
        };

        // Obtener configuración del bot (bot_type + calendar_config)
        router.get('/api/bot-config', async (req, res) => {
            try {
                const botId = getBotIdFromReq(req);
                if (!assertBotAccess(req, botId)) {
                    return res.status(403).json({ error: 'Unauthorized' });
                }
                const cfg = await botConfigService.getBotConfig(botId);
                res.json({ botId, bot_type: cfg.bot_type, calendar_config: cfg.calendar_config });
            } catch (error) {
                console.error('Error obteniendo bot config:', error);
                res.status(500).json({ error: 'Error al obtener configuración del bot' });
            }
        });

        // Guardar configuración del bot
        router.post('/api/bot-config', async (req, res) => {
            try {
                const botId = getBotIdFromReq(req);
                if (!assertBotAccess(req, botId)) {
                    return res.status(403).json({ error: 'Unauthorized' });
                }

                const { bot_type, calendar_config } = req.body || {};
                const ok = await botConfigService.saveBotConfig(botId, {
                    bot_type: bot_type || 'CARRITO',
                    calendar_config: calendar_config || {}
                });
                if (!ok) return res.status(500).json({ error: 'No se pudo guardar' });
                res.json({ success: true });
            } catch (error) {
                console.error('Error guardando bot config:', error);
                res.status(500).json({ error: 'Error al guardar configuración del bot' });
            }
        });

        // Probar disponibilidad de un calendario para una fecha (vista previa en el editor)
        router.get('/api/bot-config/disponibilidad', async (req, res) => {
            try {
                const botId = getBotIdFromReq(req);
                if (!assertBotAccess(req, botId)) {
                    return res.status(403).json({ error: 'Unauthorized' });
                }

                const cfg = await botConfigService.getBotConfig(botId);
                const cc = cfg.calendar_config || {};
                if (!cc.calendar_id) {
                    return res.json({ error: 'No hay calendar_id configurado', slots: [] });
                }

                const hoy = new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'America/Argentina/Buenos_Aires',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                }).format(new Date());

                const fecha = req.query.fecha || hoy;
                const slots = await calendarService.consultarDisponibilidad({
                    calendarId: cc.calendar_id,
                    fecha,
                    duracionMin: cc.slot_duration_minutes || 30,
                    businessHours: cc.business_hours || {},
                    minNoticeHours: cc.min_notice_hours || 0
                });
                res.json({ fecha, slots });
            } catch (error) {
                console.error('Error consultando disponibilidad:', error);
                res.status(500).json({ error: error.message, slots: [] });
            }
        });

        // Vista Principal
        router.get('/', async (req, res) => {
            try {
                const {
                    service,
                    botId,
                    isAdmin
                } = await getServiceInfo(req);

                if (!service) {
                    return res.status(404).send('Bot no encontrado.');
                }

                const menuData = await service.getMenuData();
                const hasMenuContent = menuData.length > 1;
                const activeClients = await userService.getActiveClients();

                const targetUser = (await userService.getUsers()).find(u => u.idCliente === botId);
                const scheduleConfig = {
                    online24_7: targetUser ? targetUser.online24_7 !== false : true,
                    horarios: targetUser ? parseHorariosJson(targetUser.horarios) : {}
                };

            let botSelector = '';
            if (isAdmin) {
                let botOptions = activeClients.map(client =>
                    `<option value="${client.idCliente}" ${client.idCliente === botId ? 'selected' : ''}>${client.nombreCliente} (${client.idCliente})</option>`
                ).join('');

                botSelector = `
                    <label style="margin-right: auto; display:inline-flex; align-items:center;">Bot:
                    <select onchange="window.location.href='/app/?botId=' + this.value" style="margin-left:6px;">
                        ${botOptions}
                    </select>
                    </label>
                `;
            } else {
                botSelector = `<span style="background: #e9ecef; padding: 5px 10px; border-radius: 5px; font-weight: bold; color: #495057; margin-right: auto;">${req.user.nombreCliente}</span>`;
            }

            const depthMap = {};
            menuData.forEach(n => {
                let d = 0, cur = n, guard = 0;
                while (cur.parentId && cur.parentId !== 'root' && guard < 20) {
                    d++;
                    cur = menuData.find(p => p.id === cur.parentId) || {};
                    guard++;
                }
                depthMap[n.id] = d;
            });

            let rowsHtml = menuData.map((node, idx) => {
                let displayTrigger = node.trigger;
                let displayTitle = node.title;

                if (node.id === 'root') {
                    displayTrigger = '<span style="color: #999;">-</span>';
                    displayTitle = '<span style="color: #999; font-style: italic;">(Configuración Inicial)</span>';
                }

                const depth = depthMap[node.id] || 0;

                const isOrder = node.message && node.message.includes('##PEDIDO##');
                const isQty = node.message && node.message.includes('##CANTIDAD##');
                const isFinal = node.message && node.message.includes('##FINALIZAR##');
                const isData = node.message && node.message.includes('##DATOS##');
                const isArchivo = node.message && node.message.includes('##ARCHIVO##');
                const isPagar = node.message && node.message.includes('##PAGAR##');
                const cleanMessage = (node.message || "")
                    .replace('##PEDIDO##', '')
                    .replace('##CANTIDAD##', '')
                    .replace('##FINALIZAR##', '')
                    .replace('##DATOS##', '')
                    .replace('##ARCHIVO##', '')
                    .replace('##COMPLETAR##', '')
                    .replace('##PAGAR##', '')
                    .replace('##TURNO##', '')
                    .trim();

                const connector = depth > 0 ? '└─ ' : '';
                const indent = depth > 0 ? ` style="padding-left: ${depth * 16}px;"` : '';
                return `
                <tr>
                    <td${indent}><span class="connector" style="color: #999;">${connector}</span><b>${displayTrigger}</b></td>
                    <td>${displayTitle}</td>
                    <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${cleanMessage}</td>
                    <td>
                        <div style="display: flex; flex-direction: column; gap: 3px;">
                            <button type="button" onclick="openEditModal(${idx})" class="btn-action btn-orange">Editar</button>
                            <span class="tooltip-hover tooltip-left">
                                <button type="button" onclick="openAddModal(${idx})" class="btn-action btn-blue">+ Hijo</button>
                                <span class="tooltip-bubble" style="width: 200px;">Agrega un nodo hijo debajo de este. El usuario podrá llegar a él escribiendo este disparador. Usalo para crear submenús o subopciones de un item.</span>
                            </span>
                            <button type="button" onclick="confirmDelete(${idx})" class="btn-action btn-red">Borrar</button>
                        </div>
                    </td>
                    <td class="col-precio">${node.price ? '$' + node.price : '-'}</td>
                    <td class="col-pedido" style="text-align: center;">${isOrder ? '<span style="color: var(--primary-color);">' + icon('checkCircle', 'w-4 h-4 inline text-green-400') + '</span>' : '-'}</td>
                    <td class="col-cant" style="text-align: center;">${isQty ? '<span style="color: var(--info-color);">' + icon('hashtag', 'w-4 h-4 inline') + '</span>' : '-'}</td>
                    <td class="col-fin" style="text-align: center;">${isFinal ? '<span style="color: var(--secondary-color);">' + icon('flag', 'w-4 h-4 inline') + '</span>' : '-'}</td>
                    <td class="col-datos" style="text-align: center;">${isData ? '<span style="color: var(--warning-color);">' + icon('documentText', 'w-4 h-4 inline') + '</span>' : '-'}</td>
                    <td class="col-archivo" style="text-align: center;">${isArchivo ? '<span style="color: var(--info-color);">' + icon('paperClip', 'w-4 h-4 inline') + '</span>' : '-'}</td>
                    <td class="col-pagar" style="text-align: center;">${isPagar ? '<span style="color: var(--success-color);">' + icon('creditCard', 'w-4 h-4 inline') + '</span>' : '-'}</td>
                    <td class="col-redirigir" style="text-align: center; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${node.redirigirA || '<span style="color:#999;">-</span>'}</td>
                    <td class="col-disp" style="text-align: center;">${node.disponible === 'false' ? '<span style="color:#999;" title="No disponible">' + icon('noSymbol', 'w-4 h-4 inline text-red-400') + '</span>' : '<span style="color:var(--primary-color);" title="Disponible">' + icon('checkCircle', 'w-4 h-4 inline text-green-400') + '</span>'}</td>
                </tr>
                `;
            }).join('');
            res.send(`
                <html>
                <head>
                    <title>Editor de Menú de WhatsApp - ${botId}</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
                            --warning-color: #fd7e14;
                            --secondary-color: #6f42c1;
                        }

                        body { 
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                            margin: 24px; 
                            background: var(--bg-white); 
                            color: var(--text-main);
                        }

                        .header { 
                            display: flex; 
                            justify-content: space-between; 
                            align-items: center; 
                            margin-bottom: 16px;
                            padding-bottom: 20px;
                            border-bottom: 2px solid var(--border-color);
                            flex-wrap: wrap;
                        }

                        table { 
                            width: 100%; 
                            border-collapse: collapse; 
                            background: var(--bg-box); 
                            margin-top: 12px; 
                            box-shadow: 0 2px 4px rgba(0,0,0,0.02);
                            border: 1px solid var(--border-color);
                            border-radius: 6px;
                            overflow: hidden;
                            font-size: 12px;
                        }

                        th, td { 
                            padding: 4px 6px; 
                            border: 1px solid var(--border-color); 
                            text-align: left; 
                        }

                        th { 
                            background: var(--bg-box); 
                            color: var(--text-muted);
                            font-weight: 600;
                            text-transform: uppercase;
                            font-size: 10px;
                            letter-spacing: 0.3px;
                        }
                        th.th-mini {
                            font-size: 8px;
                            letter-spacing: 0;
                        }
                        .col-toggle-wrap { position: relative; }
                        .col-toggle-btn {
                            position: absolute;
                            top: 8px;
                            right: 8px;
                            z-index: 10;
                            background: var(--bg-box);
                            border: 1px solid var(--border-color);
                            border-radius: 6px;
                            padding: 4px 8px;
                            cursor: pointer;
                            font-size: 14px;
                            color: var(--text-muted);
                            line-height: 1;
                            box-shadow: 0 2px 6px rgba(0,0,0,0.08);
                        }
                        .col-toggle-menu {
                            display: none;
                            position: absolute;
                            top: 34px;
                            right: 8px;
                            z-index: 20;
                            background: var(--bg-white);
                            border: 1px solid var(--border-color);
                            border-radius: 8px;
                            box-shadow: 0 8px 24px rgba(0,0,0,0.15);
                            padding: 12px 14px;
                            min-width: 170px;
                        }
                        .col-toggle-menu.open { display: block; }
                        .col-toggle-menu .ctm-title {
                            font-size: 12px;
                            font-weight: 700;
                            color: var(--text-main);
                            margin-bottom: 8px;
                        }
                        .col-toggle-menu label {
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            font-size: 13px;
                            color: var(--text-muted);
                            padding: 4px 0;
                            cursor: pointer;
                        }
                        .col-toggle-menu input[type="checkbox"] { width: 15px; height: 15px; cursor: pointer; }

                        .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
                            justify-content: flex-end;
                            position: sticky;
                            top: 0;
                            z-index: 100;
                            margin-top: 14px;
                            padding: 12px 16px;
                            border: 1px solid var(--border-color);
                            background: var(--bg-box);
                            border-radius: 12px;
                            box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                            transition: box-shadow 0.3s ease, padding 0.3s ease;
                        }
                        .toolbar.is-stuck {
                            box-shadow: 0 4px 16px rgba(0,0,0,0.12);
                            padding: 8px 16px;
                        }
                        .toolbar .btn { min-width: 0; padding: 4px 8px; font-size: 11px; border-radius: 3px; gap: 4px; }
                        .toolbar select, .toolbar label { font-size: 14px; white-space: nowrap; }
                        .tooltip-hover { position: relative; display: inline-flex; }
                        .tooltip-hover .tooltip-bubble {
                            visibility: hidden;
                            opacity: 0;
                            position: absolute;
                            bottom: calc(100% + 8px);
                            left: 50%;
                            transform: translateX(-50%);
                            width: 260px;
                            background: #333;
                            color: #fff;
                            font-size: 12px;
                            line-height: 1.4;
                            font-weight: 400;
                            text-align: center;
                            padding: 10px 12px;
                            border-radius: 6px;
                            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                            z-index: 130;
                            transition: opacity 0.2s;
                            pointer-events: none;
                            white-space: normal;
                        }
                        .tooltip-hover .tooltip-bubble::after {
                            content: "";
                            position: absolute;
                            top: 100%;
                            left: 50%;
                            margin-left: -5px;
                            border-width: 5px;
                            border-style: solid;
                            border-color: #333 transparent transparent transparent;
                        }
                        .tooltip-hover:hover .tooltip-bubble { visibility: visible; opacity: 1; }
                        .tooltip-hover.tooltip-below .tooltip-bubble {
                            bottom: auto;
                            top: calc(100% + 8px);
                            transform: translateX(-50%);
                        }
                        .tooltip-hover.tooltip-below .tooltip-bubble::after {
                            top: auto;
                            bottom: 100%;
                            margin-left: -5px;
                            border-color: transparent transparent #333 transparent;
                        }
                        .tooltip-hover.tooltip-left .tooltip-bubble {
                            bottom: auto;
                            top: 50%;
                            left: auto;
                            right: calc(100% + 8px);
                            transform: translateY(-50%);
                        }
                        .tooltip-hover.tooltip-left .tooltip-bubble::after {
                            top: 50%;
                            left: 100%;
                            margin-left: 0;
                            margin-top: -5px;
                            transform: translateY(-50%);
                            border-width: 5px;
                            border-style: solid;
                            border-color: transparent transparent transparent #333;
                        }
                        .status-box {
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                            margin-top: 4px;
                            padding: 3px 10px;
                            border: 1px solid var(--border-color);
                            border-radius: 20px;
                            font-size: 11px;
                            color: var(--text-muted);
                            background: var(--bg-box);
                        }
                        .status-dot {
                            display: inline-block;
                            width: 8px;
                            height: 8px;
                            border-radius: 50%;
                            transition: background 0.3s;
                        }
                        .status-dot.on { background: #22c55e; box-shadow: 0 0 4px rgba(34,197,94,0.5); }
                        .status-dot.off { background: #9ca3af; box-shadow: 0 0 4px rgba(156,163,175,0.3); }
                        .status-dot.error { background: #ef4444; box-shadow: 0 0 4px rgba(239,68,68,0.5); }
                        
                        .btn { 
                            padding: 10px 18px; 
                            text-decoration: none; 
                            border-radius: 6px; 
                            border: 1px solid var(--border-color);
                            cursor: pointer; 
                            color: var(--text-muted); 
                            background: var(--bg-box);
                            font-weight: 600; 
                            font-size: 14px; 
                            transition: all 0.2s;
                            display: inline-flex;
                            align-items: center;
                            justify-content: center;
                            white-space: nowrap;
                            min-width: 100px;
                            box-sizing: border-box;
                            font-family: inherit;
                            line-height: 1;
                        }

                        button.btn { padding: 11px 18px; }

                        .btn:hover { 
                            background: var(--primary-color); 
                            color: white;
                            border-color: var(--primary-color);
                        }
                        
                        /* Unified Action Buttons */
                        .btn-action { 
                            padding: 4px 8px; 
                            border: 1px solid var(--border-color); 
                            border-radius: 3px; 
                            cursor: pointer; 
                            color: var(--text-muted); 
                            background: var(--bg-box);
                            font-size: 11px; 
                            font-weight: 600; 
                            transition: all 0.15s; 
                            box-sizing: border-box;
                            font-family: inherit;
                            line-height: 1;
                            width: 62px;
                            display: inline-flex;
                            align-items: center;
                            justify-content: center;
                            height: 26px;
                        }
                        .btn-action:hover { 
                            background: var(--primary-color); 
                            color: white; 
                            border-color: var(--primary-color);
                        }

                        /* Toolbar button colors */
                        .btn-admin { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
                        .btn-admin:hover { background: #2563eb; color: white; border-color: #2563eb; }
                        .btn-pagos { background: #ecfdf5; color: #059669; border-color: #a7f3d0; }
                        .btn-pagos:hover { background: #059669; color: white; border-color: #059669; }
                        .btn-visual { background: #f5f3ff; color: #7c3aed; border-color: #ddd6fe; }
                        .btn-visual:hover { background: #7c3aed; color: white; border-color: #7c3aed; }
                        .btn-qr { background: #ecfdf5; color: #00bc7d; border-color: #a7f3d0; }
                        .btn-qr:hover { background: #00bc7d; color: white; border-color: #00bc7d; }
                        .btn-refresh { background: #fff7ed; color: #ea580c; border-color: #fed7aa; }
                        .btn-refresh:hover { background: #ea580c; color: white; border-color: #ea580c; }
                        .btn-sheet { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
                        .btn-sheet:hover { background: #2563eb; color: white; border-color: #2563eb; }
                        .btn-calendar { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
                        .btn-calendar:hover { background: #2563eb; color: white; border-color: #2563eb; }
                        .btn-red {
                            background: #fef2f2 !important;
                            color: #dc2626 !important;
                            border: 1px solid #fecaca !important;
                        }
                        .btn-red:hover {
                            background: #dc2626 !important;
                            color: white !important;
                            border-color: #dc2626 !important;
                        }
                        
                        select { 
                            padding: 10px; 
                            border-radius: 6px; 
                            border: 1px solid var(--border-color); 
                            font-weight: 600; 
                            background: var(--bg-box);
                            color: var(--text-main);
                        }
                        
                        /* Modal Styles */
                        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); backdrop-filter: blur(2px); overflow-y: auto; padding: 20px 0; }
                        .modal-content { 
                            background: var(--bg-white); 
                            margin: 20px auto; 
                            padding: 18px 20px; 
                            width: 50%; 
                            max-height: calc(100vh - 80px);
                            overflow-y: auto;
                            border-radius: 12px; 
                            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                            border: 1px solid var(--border-color);
                            position: relative;
                        }
                        .modal-content h2 { margin-top: 0; color: var(--text-main); margin-bottom: 14px; font-size: 18px; }
                        
                        .form-group { margin-bottom: 12px; }
                        .form-group label { display: block; margin-bottom: 4px; font-weight: 600; color: var(--text-muted); font-size: 13px; }
                        .form-group input, .form-group textarea { 
                            width: 100%; 
                            padding: 8px 10px; 
                            border: 1px solid var(--border-color); 
                            border-radius: 6px; 
                            box-sizing: border-box; 
                            font-size: 14px;
                            background: var(--bg-box);
                            color: var(--text-main);
                            transition: border-color 0.2s;
                        }
                        .form-group input:focus, .form-group textarea:focus {
                            outline: none;
                            border-color: var(--primary-color);
                        }
                        
                        .tree ul { padding-top: 20px; position: relative; transition: all 0.5s; display: flex; justify-content: center; }
                        .tree li { text-align: center; list-style-type: none; position: relative; padding: 20px 5px 0 5px; transition: all 0.5s; }
                        .tree li::before, .tree li::after { content: ''; position: absolute; top: 0; right: 50%; border-top: 1px solid var(--border-color); width: 50%; height: 20px; }
                        .tree li::after { right: auto; left: 50%; border-left: 1px solid var(--border-color); }
                        .tree li:only-child::after, .tree li:only-child::before { display: none; }
                        .tree li:only-child { padding-top: 0; }
                        .tree li:first-child::before, .tree li:last-child::after { border: 0 none; }
                        .tree li:last-child::before { border-right: 1px solid var(--border-color); border-radius: 0 5px 0 0; }
                        .tree li:first-child::after { border-radius: 5px 0 0 0; }
                        .tree ul ul::before { content: ''; position: absolute; top: 0; left: 50%; border-left: 1px solid var(--border-color); width: 0; height: 20px; }
                        .tree li div { 
                            border: 1px solid var(--border-color); 
                            padding: 10px 15px; 
                            text-decoration: none; 
                            color: var(--text-muted); 
                            font-size: 12px; 
                            display: inline-block; 
                            border-radius: 6px; 
                            background: var(--bg-box); 
                            box-shadow: 0 2px 4px rgba(0,0,0,0.02);
                        }

                        /* WhatsApp Preview Styles */
                        .modal-body-wrapper { display: flex; gap: 18px; align-items: flex-start; }
                        .form-column { flex: 0 0 65%; }
                        .chat-column { flex: 0 0 35%; position: sticky; top: 0; }

                        .whatsapp-container {
                            background: #e5ddd5;
                            background-image: url('https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png');
                            border-radius: 12px;
                            overflow: hidden;
                            border: 1px solid var(--border-color);
                            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
                        }
                        .whatsapp-header {
                            background: #075e54;
                            color: white;
                            padding: 10px 15px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        }
                        .whatsapp-body {
                            padding: 15px;
                            height: 350px;
                            overflow-y: auto;
                            display: flex;
                            flex-direction: column;
                            gap: 10px;
                        }
                        .wa-bubble {
                            background: white;
                            padding: 8px 12px;
                            border-radius: 0 10px 10px 10px;
                            max-width: 85%;
                            font-size: 14px;
                            position: relative;
                            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                            white-space: pre-wrap;
                            word-wrap: break-word;
                            color: #333;
                            line-height: 1.4;
                        }
                        .wa-bubble::before {
                            content: '';
                            position: absolute;
                            left: -10px;
                            top: 0;
                            border: 10px solid transparent;
                            border-top-color: white;
                            border-right-color: white;
                        }
                        .wa-bubble-user {
                            align-self: flex-end;
                            background: #dcf8c6;
                            padding: 8px 12px;
                            border-radius: 10px 0 10px 10px;
                            max-width: 85%;
                            font-size: 14px;
                            position: relative;
                            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
                            color: #333;
                            line-height: 1.4;
                        }
                        .wa-bubble-user::after {
                            content: '';
                            position: absolute;
                            right: -10px;
                            top: 0;
                            border: 10px solid transparent;
                            border-top-color: #dcf8c6;
                            border-left-color: #dcf8c6;
                        }
                        .wa-footer {
                            background: #f0f0f0;
                            padding: 10px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        }
                        .wa-input {
                            background: white;
                            flex: 1;
                            height: 35px;
                            border-radius: 20px;
                        }

                        /* Tooltip Styles */
                        .info-icon {
                            display: inline-flex;
                            align-items: center;
                            justify-content: center;
                            width: 16px;
                            height: 16px;
                            background: #e9ecef;
                            color: #6c757d;
                            border-radius: 50%;
                            font-size: 11px;
                            font-weight: bold;
                            cursor: help;
                            margin-left: 5px;
                            position: relative;
                        }
                        .tooltip {
                            visibility: hidden;
                            width: 250px;
                            background-color: #333;
                            color: #fff;
                            text-align: center;
                            border-radius: 6px;
                            padding: 10px;
                            position: absolute;
                            z-index: 101;
                            bottom: 125%;
                            left: 50%;
                            margin-left: -125px;
                            opacity: 0;
                            transition: opacity 0.3s;
                            font-weight: normal;
                            font-size: 12px;
                            line-height: 1.4;
                            pointer-events: none;
                            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                        }
                        .tooltip::after {
                            content: "";
                            position: absolute;
                            top: 100%;
                            left: 50%;
                            margin-left: -5px;
                            border-width: 5px;
                            border-style: solid;
                            border-color: #333 transparent transparent transparent;
                        }
                        .info-icon:hover .tooltip {
                            visibility: visible;
                            opacity: 1;
                        }

${helpGuideCSS}

                        /* Support Bot */
                        .support-toggle {
                            position: fixed;
                            bottom: 20px;
                            right: 20px;
                            background: white;
                            border-radius: 16px;
                            padding: 10px 14px 8px 14px;
                            box-shadow: 0 4px 20px rgba(0,0,0,0.12);
                            border: 1px solid var(--border-color);
                            cursor: pointer;
                            z-index: 120;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            gap: 2px;
                            transition: transform 0.2s, box-shadow 0.2s, all 0.2s;
                            user-select: none;
                        }
                        .support-toggle .support-toggle-min {
                            position: absolute;
                            top: -6px;
                            right: -6px;
                            width: 18px;
                            height: 18px;
                            border-radius: 50%;
                            background: #dc3545;
                            color: white;
                            font-size: 12px;
                            font-weight: 700;
                            line-height: 16px;
                            text-align: center;
                            cursor: pointer;
                            border: 1px solid white;
                            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
                            z-index: 2;
                        }
                        .support-toggle.minimized {
                            width: 24px;
                            height: 24px;
                            padding: 0;
                            border-radius: 50%;
                            background: var(--primary-color);
                            box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                            animation: heartbeat 1.6s ease-in-out infinite;
                        }
                        .support-toggle.minimized:hover { transform: scale(1); box-shadow: 0 2px 10px rgba(0,0,0,0.2); }
                        .support-toggle.minimized img,
                        .support-toggle.minimized .label,
                        .support-toggle.minimized .support-toggle-min { display: none; }
                        @keyframes heartbeat {
                            0%, 100% { transform: scale(1); }
                            20% { transform: scale(1.15); }
                            40% { transform: scale(1); }
                            60% { transform: scale(1.12); }
                            80% { transform: scale(1); }
                        }
                        .support-toggle:hover { transform: scale(1.05); box-shadow: 0 6px 25px rgba(0,0,0,0.15); }
                        .support-toggle img { display: block; }
                        .support-toggle .label {
                            font-size: 11px;
                            color: var(--primary-color);
                            font-weight: 600;
                            letter-spacing: 0.3px;
                        }
                        .support-modal {
                            position: fixed;
                            bottom: 90px;
                            right: 20px;
                            width: 380px;
                            height: 520px;
                            background: var(--bg-white);
                            border-radius: 16px;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.15);
                            border: 1px solid var(--border-color);
                            z-index: 119;
                            display: none;
                            flex-direction: column;
                            overflow: hidden;
                        }
                        .support-modal.open { display: flex; }
                        .support-header {
                            background: var(--primary-color);
                            color: white;
                            padding: 15px 20px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        }
                        .support-header h4 { margin: 0; font-size: 15px; flex: 1; }
                        .support-header .sub { font-size: 11px; opacity: 0.8; }
                        .support-body {
                            flex: 1;
                            padding: 15px;
                            overflow-y: auto;
                            display: flex;
                            flex-direction: column;
                            gap: 10px;
                            background: #f8f9fa;
                        }
                        .support-body .sb-bubble {
                            max-width: 85%;
                            padding: 10px 14px;
                            border-radius: 12px;
                            font-size: 14px;
                            line-height: 1.5;
                            white-space: pre-wrap;
                            word-wrap: break-word;
                        }
                        .support-body .sb-bubble.bot {
                            background: white;
                            align-self: flex-start;
                            border-bottom-left-radius: 4px;
                            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
                            color: #333;
                        }
                        .support-body .sb-bubble.user {
                            background: var(--primary-color);
                            color: white;
                            align-self: flex-end;
                            border-bottom-right-radius: 4px;
                        }
                        .support-body .typing {
                            align-self: flex-start;
                            display: flex;
                            gap: 4px;
                            padding: 12px 16px;
                            background: white;
                            border-radius: 12px;
                            border-bottom-left-radius: 4px;
                        }
                        .support-body .typing span {
                            width: 8px;
                            height: 8px;
                            background: #ccc;
                            border-radius: 50%;
                            animation: typing 1.4s infinite;
                        }
                        .support-body .typing span:nth-child(2) { animation-delay: 0.2s; }
                        .support-body .typing span:nth-child(3) { animation-delay: 0.4s; }
                        @keyframes typing { 0%,60%,100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-4px); } }
                        .support-footer {
                            padding: 10px 15px;
                            border-top: 1px solid var(--border-color);
                            display: flex;
                            gap: 10px;
                            background: white;
                        }
                        .support-footer input {
                            flex: 1;
                            padding: 10px 14px;
                            border: 1px solid var(--border-color);
                            border-radius: 24px;
                            font-size: 14px;
                            outline: none;
                            transition: border-color 0.2s;
                        }
                        .support-footer input:focus { border-color: var(--primary-color); }
                        .support-footer button {
                            width: 40px;
                            height: 40px;
                            border-radius: 50%;
                            background: var(--primary-color);
                            color: white;
                            border: none;
                            cursor: pointer;
                            font-size: 16px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            transition: background 0.2s;
                            flex-shrink: 0;
                        }
                        .support-footer button:hover { background: #6d28d9; }
                        .support-footer button:disabled { background: #ccc; cursor: not-allowed; }
                        .support-footer .suggestion-chips {
                            display: flex;
                            flex-wrap: wrap;
                            gap: 6px;
                            margin-bottom: 8px;
                        }
                        .support-footer .chip {
                            padding: 5px 12px;
                            background: #f3f0ff;
                            color: var(--primary-color);
                            border: 1px solid #ddd6fe;
                            border-radius: 16px;
                            font-size: 12px;
                            cursor: pointer;
                            transition: all 0.2s;
                        }
                        .support-footer .chip:hover { background: var(--primary-color); color: white; border-color: var(--primary-color); }

                        /* Mobile Responsive */
                        @media (max-width: 768px) {
                            body { margin: 12px; }
                            .header { flex-direction: column; align-items: stretch; gap: 12px; }
                            .header > div { justify-content: center; }
                            .header h3 { text-align: center; font-size: 16px; }
                            .toolbar { justify-content: flex-end; position: static; }
                            .toolbar.is-stuck { padding: 12px 16px; border-radius: 12px; box-shadow: none; }
                            .toolbar .btn, .toolbar select { width: 100%; min-width: unset; box-sizing: border-box; }
                            .toolbar .tooltip-hover { width: 100%; box-sizing: border-box; }
                            .toolbar .tooltip-hover .btn { width: 100%; }
                            .toolbar select { font-size: 14px; }
                            .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -4px; }
                            .table-wrap table { min-width: 680px; }
                            .modal-content { width: 95% !important; max-width: 100% !important; margin: 10px auto; padding: 16px; box-sizing: border-box; }
                            .modal { padding: 10px 0; }
                            .modal-body-wrapper { flex-direction: column; }
                            .form-column { flex: 1 1 auto !important; }
                            .chat-column { flex: 1 1 auto !important; position: static !important; }
                            .chat-column .whatsapp-container { position: static !important; }
                            .whatsapp-body { height: 250px; }
                            #wizardContainer > div { flex-direction: column; }
                            .info-icon .tooltip { width: 200px; margin-left: -100px; font-size: 11px; }
                            #wizardAsk { padding: 20px 10px; }
                            #wizardAsk p { font-size: 16px; }
                            #wizardAsk button { padding: 12px 20px !important; font-size: 14px !important; width: 100%; }
                            .support-modal { right: 10px; bottom: 80px; width: calc(100% - 20px); height: 60vh; }
                            .support-toggle { right: 10px; bottom: 10px; }
                            .btn { min-width: unset; }
                            #editTriggerGroup { flex-direction: column; }
                            #editTriggerGroup .form-group { flex: 1 1 auto; }
                            #addFullForm .modal-body-wrapper .form-column > form > div:first-child { flex-direction: column; }
                            #addFullForm .modal-body-wrapper .form-column > form .tags-flex-row,
                            #editTagsGroup .tags-flex-row { flex-direction: column; }
                            .help-sidebar { width: 280px; left: -280px; }
                            .help-toggle.open { left: 280px; }
                        }
                        @media (max-width: 480px) {
                            body { margin: 8px; }
                            .table-wrap table { font-size: 12px; }
                            .header h3 { font-size: 14px; }
                            .status-box { font-size: 10px; padding: 2px 8px; }
                            .modal-content { padding: 12px; }
                            .form-group input, .form-group textarea { font-size: 16px; padding: 10px; }
                            .form-group label { font-size: 13px; }
                            .whatsapp-body { height: 200px; }
                            .wa-bubble, .wa-bubble-user { max-width: 90%; font-size: 13px; }
                            .support-modal { width: calc(100% - 10px); right: 5px; bottom: 75px; height: 55vh; }
                            .support-toggle { right: 5px; bottom: 5px; padding: 8px 10px 6px 10px; }
                            .support-toggle canvas { width: 32px; height: 32px; }
                            .help-sidebar { width: 240px; left: -240px; }
                            .help-toggle.open { left: 240px; }
                            #wizardAsk button { padding: 10px 16px !important; font-size: 13px !important; }
                        }
                    </style>
                    <script src="/js/robot-logo.js"></script>
                </head>
                <body>
                    <div class="header">
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <a href="/" style="display:block;"><img src="/img/wamenu_logo_name.png" alt="WaMenu Banner" style="width:100%;max-width:10em;height:auto;margin-bottom:10px;display:block;margin-left:auto;margin-right:auto;object-fit:contain;"></a>
                            <div>
                                <h3 style="margin:0;">(Modo: Editor)</h3>
                                <div class="status-box" id="statusBox"><span class="status-dot off" id="statusDot"></span> <span id="statusLabel">Verificando...</span><span class="status-help" id="statusHelp" style="display:none;position:relative;cursor:pointer;margin-left:6px;font-size:13px;color:#888;border:1px solid #ccc;border-radius:50%;width:18px;height:18px;line-height:18px;text-align:center;font-weight:700;">?<span class="status-help-tip" style="display:none;position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 14px;border-radius:8px;font-size:12px;font-weight:400;line-height:1.5;white-space:normal;width:240px;text-align:left;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.15);"></span></span></div>
                            </div>
                        </div>

                        <script>
                        (function(){
                            var help=document.getElementById('statusHelp');
                            if(!help)return;
                            var tip=help.querySelector('.status-help-tip');
                            help.addEventListener('mouseenter',function(){tip.style.display='block';});
                            help.addEventListener('mouseleave',function(){tip.style.display='none';});
                        })();
                        </script>
                    </div>
                    ${!req.user.emailVerified ? '<div style="width:100%;max-width:1000px;padding:12px 20px;margin:0 auto 16px;background:#fff4e5;border:1px solid #ff980040;border-radius:8px;font-size:14px;color:#b45309;text-align:center;">Tu email no está verificado. Revisá tu casilla o <a href="/app/verify-email-sent" style="color:#b45309;text-decoration:underline;font-weight:600;">reenviá el email de verificación</a>.</div>' : ''}
                    ${(() => {
                        if (!targetUser || !targetUser.trialEndDate) return '';
                        const estado = billingService.estadoSuscripcion(targetUser.fechaVencimiento, targetUser.trialEndDate);
                        if (estado !== 'trial') return '';
                        const diasR = billingService.diasRestantesTrial(targetUser.trialEndDate);
                        if (diasR === null || diasR === undefined || diasR < 0) return '';
                        const bannerColor = diasR <= 2 ? '#dc2626' : (diasR <= 5 ? '#b45309' : '#00bc7d');
                        const bannerText = diasR === 0
                            ? 'Tu prueba termina hoy'
                            : 'Te quedan ' + diasR + ' día' + (diasR !== 1 ? 's' : '') + ' de prueba gratuita';
                        return '<div style="width:100%;max-width:1000px;padding:10px 16px;margin:0 auto 16px;background:' + bannerColor + '15;border:1px solid ' + bannerColor + '40;border-radius:8px;font-size:13px;color:' + bannerColor + ';text-align:center;font-weight:600;">' +
                            bannerText + (diasR <= 5 ? ' — <a href="/suscripcion" style="color:' + bannerColor + ';text-decoration:underline;">Activar plan</a>' : '') +
                            '</div>';
                    })()}
                    <div class="toolbar">
                            ${botSelector}
                            ${isAdmin ? `<a href="/app/admin" class="btn btn-admin">${icon('cog6Tooth', 'w-4 h-4 inline')} Admin</a>` : ''}
                            ${isAdmin ? '' : `<button onclick="showMisPagos()" class="btn btn-pagos">${icon('creditCard', 'w-4 h-4 inline')} Mis Pagos</button>`}
                            <button onclick="showVisual()" class="btn btn-visual">${icon('eye', 'w-4 h-4 inline')} Visualizar</button>
                            <a href="/app/qr" class="btn btn-qr">${icon('qrCode', 'w-4 h-4 inline')} WhatsApp QR</a>
                            <a href="/app/refresh?botId=${botId}" class="btn btn-refresh">${icon('arrowPath', 'w-4 h-4 inline')} Refrescar</a>
                            <span class="tooltip-hover tooltip-below">
                                <a href="/app/pedidos/${botId}" target="_blank" class="btn btn-pagos">${icon('documentText', 'w-4 h-4 inline')} Pedidos</a>
                                <span class="tooltip-bubble">Si configurás tu bot como "Bot de catálogo" podrás ver los pedidos en esta base de datos.</span>
                            </span>
                            <a href="https://calendar.google.com/calendar/r" target="_blank" class="btn btn-calendar">${icon('calendar', 'w-4 h-4 inline')} Calendario</a>
                            ${isAdmin ? `<a href="https://docs.google.com/spreadsheets/d/${service.spreadsheetId}" target="_blank" class="btn btn-sheet">${icon('document', 'w-4 h-4 inline')} Sheet</a>` : ''}
                            <a href="/app/logout" class="btn btn-red">${icon('arrowLeft', 'w-4 h-4 inline')} Salir</a>
                    </div>

${helpGuideHTML}

                    <!-- Tipo de Bot + Google Calendar -->
                    <div class="schedule-section">
                        <div class="step-toggle" onclick="toggleStep('step1Body', this)" style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                            <div>
                                <div style="display:inline-block; background:#0f6b4f; color:#fff; font-size:11px; font-weight:700; letter-spacing:0.5px; padding:4px 10px; border-radius:4px; margin-bottom:8px;">PASO 1 · CONFIGURÁ EL TIPO DE BOT</div>
                                <h3>${icon('sparkles', 'w-4 h-4 inline text-purple-400')} Tipo de Bot</h3>
                            </div>
                            <span class="step-toggle-arrow" style="font-size:14px; color:var(--text-muted); transform:rotate(-90deg);">${icon('chevronDown', 'w-4 h-4 inline')}</span>
                        </div>
                        <div class="step-body" id="step1Body" style="display:none;">
                        <p class="muted">Definí qué tipo de operación maneja este bot. Al elegir <strong>"Gestor de Turnos"</strong> se ocultan los módulos de carrito y se habilita la configuración de Google Calendar.</p>
                        <div class="online-row">
                            <select id="botTypeInput" onchange="onBotTypeChange()" style="padding: 10px 14px; border: 1px solid var(--border-color); border-radius: 8px; font-size: 15px; width: 100%; max-width: 420px;">
                                <option value="CARRITO">${icon('shoppingCart', 'w-4 h-4 inline')} Bot de Catálogo / Carrito de Compras (Ventas, Menú, Productos)</option>
                                <option value="TURNOS">${icon('calendar', 'w-4 h-4 inline')} Bot Gestor de Turnos / Agenda (Reservas, Citas)</option>
                                <option value="FAQ">${icon('questionMarkCircle', 'w-4 h-4 inline')} Bot de Consultas Generales / FAQ</option>
                            </select>
                        </div>

                        <div id="calendarSection" style="display: none; margin-top: 18px; padding: 16px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px;">
                            <div onclick="toggleCalendarSection()" style="font-weight: 700; color: #166534; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;">${icon('calendar', 'w-4 h-4 inline')} Configuración de Google Calendar
                                <span class="calendar-toggle-arrow" id="calendarToggleArrow" style="display:inline-flex;align-items:center;justify-content:center;font-size:12px;transition:transform 0.2s;transform:rotate(-90deg);">${icon('chevronDown', 'w-4 h-4 inline')}</span>
                                <span onclick="event.stopPropagation(); openCalendarHelp()" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;background:#e9ecef;color:#6c757d;border-radius:50%;font-size:12px;font-weight:bold;cursor:pointer;border:1px solid #ced4da;" title="Cómo conectar tu calendario">?</span>
                                <a href="https://youtu.be/9qY2tMi8gQk" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;background:#e9ecef;color:#6c757d;border-radius:50%;cursor:pointer;border:1px solid #ced4da;" title="Ver video tutorial">${icon('videoCamera', 'w-3 h-3 inline')}</a>
                            </div>
                            <div id="calendarBody" style="display: none;">
                            <div style="display: flex; flex-direction: column; gap: 12px;">
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Calendar ID:<span class="info-icon" style="margin-left:4px;">i<span class="tooltip" style="width: 320px; margin-left: -160px; text-align: left;">
                                        <strong>¿Cómo obtener el Calendar ID?</strong><br><br>
                                        1. Abrí <strong>Google Calendar</strong> en el navegador.<br>
                                        2. Hacé clic en el engranaje ${icon('cog6Tooth', 'w-4 h-4 inline')} ${icon('arrowRight', 'w-4 h-4 inline')} <strong>Configuración</strong>.<br>
                                        3. En el panel izquierdo, buscá tu calendario y hacé clic en su nombre.<br>
                                        4. En "Integrar calendario" está el <strong>ID del calendario</strong> (ej: <code>tucalendario@gmail.com</code> o <code>...@group.calendar.google.com</code>).<br><br>
                                        <strong>¿Cómo darle permisos de edición al bot?</strong><br><br>
                                        1. En "Configuración del calendario", buscá <strong>Compartir con usuarios específicos</strong>.<br>
                                        2. Agregá la cuenta de Google del bot: <code>${process.env.ADMIN_EMAIL || 'la cuenta de Google vinculada al bot'}</code><br>
                                        3. En el rol, elegí <strong>Realizar cambios en eventos</strong> (no solo "Ver").<br>
                                        4. Aceptá la invitación que llegue a esa cuenta.<br><br>
                                        ${icon('lightBulb', 'w-4 h-4 inline text-yellow-400')} Sin este permiso el bot no podrá crear turnos.
                                    </span></span></label>
                                    <input type="text" id="calendarIdInput" placeholder="xxxx@gmail.com o /c/...@group.calendar.google.com" style="flex: 1; min-width: 260px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                                </div>
                                <div style="font-size: 12px; color: #777;">Vinculación: compartí tu calendario con la cuenta de Google vinculada al bot (<code>${process.env.ADMIN_EMAIL || 'cuenta del bot'}</code>) con permisos de edición y pegá su ID. No hay OAuth individual por bot.</div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Duración del turno (min):</label>
                                    <input type="number" id="slotDurationInput" value="30" min="5" step="5" style="width: 100px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px;">
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Salto mínimo de reserva (hs):</label>
                                    <input type="number" id="minNoticeInput" value="2" min="0" style="width: 100px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px;">
                                    <small style="color:#777;">No permitir turnos con menos de estas horas de anticipación.</small>
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Recordatorio de turno:</label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="reminderEnabledInput" style="width:17px;height:17px;cursor:pointer;"> Activar recordatorios</label>
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Recordar (antes del turno):</label>
                                    <select id="reminderHoursInput" style="width: 120px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px;">
                                        <option value="2">2 horas</option>
                                        <option value="24">24 horas</option>
                                    </select>
                                    <small style="color:#777;">Envía un recordatorio al cliente con opciones confirmar/cancelar (solo 8:00 a 22:00 hs).</small>
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Lista de espera:</label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="waitlistEnabledInput" style="width:17px;height:17px;cursor:pointer;"> Activar lista de espera</label>
                                </div>
                                <div style="font-size: 12px; color: #777;">Con la lista de espera activa, los horarios ocupados se muestran tachados "(solicitar si cancela)" y se avisa al primero de la cola si se libera un turno.</div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Mis turnos:</label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="misTurnosEnabledInput" style="width:17px;height:17px;cursor:pointer;"> Mostrar "Mis turnos" en el menú</label>
                                </div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-left: 8px;">
                                    <label style="font-weight: 600; min-width: 200px;">Cancelación:</label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="misTurnosCancelarInput" style="width:17px;height:17px;cursor:pointer;"> Permitir cancelar turno desde "Mis turnos"</label>
                                </div>
                                <div style="font-size: 12px; color: #777;">"Mis turnos" le muestra al cliente sus turnos reservados con opciones de confirmar/cancelar. Se agrega automáticamente al menú principal.</div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-left: 8px;">
                                    <label style="font-weight: 600; min-width: 200px;">Cancelación en recordatorio:</label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="recordatorioCancelarInput" style="width:17px;height:17px;cursor:pointer;"> Permitir cancelar turno desde el recordatorio</label>
                                </div>
                                <div style="font-size: 12px; color: #777;">Si está desactivado, el recordatorio solo mostrará la opción de confirmar asistencia, sin poder cancelar el turno.</div>
                                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                                    <label style="font-weight: 600; min-width: 200px;">Reprogramar:</label>
                                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="reprogramarEnabledInput" style="width:17px;height:17px;cursor:pointer;"> Ofrecer reprogramar el turno al cancelar</label>
                                </div>
                                <div style="font-size: 12px; color: #777;">Al cancelar un turno, el bot le pregunta al cliente si quiere reprogramar su turno para otro momento (1: Sí / 2: No).</div>
                            </div>

                            <div style="margin-top: 16px;">
                                <div style="font-weight: 700; color: #166534; margin-bottom: 8px;">Días y Horarios de Atención del Negocio</div>
                                <div style="font-size: 12px; color: #777; margin-bottom: 8px;">Estos son los horarios en los que tu <strong>negocio atiende</strong> y hay <strong>turnos disponibles</strong> para reservar. Solo se ofrecerán turnos dentro de estos rangos (hora local de Argentina).<br>
                                <small>${icon('informationCircle', 'w-4 h-4 inline')} <strong>Distinto de</strong> los "Horarios de Atención del Bot" (más arriba), que definen cuándo el bot responde mensajes.</small></div>
                                <table id="businessHoursTable" style="width: 100%; max-width: 560px; border-collapse: collapse; font-size: 14px;">
                                    <thead>
                                        <tr style="text-align:left; color:#166534;">
                                            <th style="padding:4px 8px;">Día</th>
                                            <th style="padding:4px 8px;">Atiende</th>
                                            <th style="padding:4px 8px;">Desde</th>
                                            <th style="padding:4px 8px;">Hasta</th>
                                        </tr>
                                    </thead>
                                    <tbody id="businessHoursBody"></tbody>
                                </table>
                            </div>

                            <div class="schedule-actions">
                                <button class="btn btn-green schedule-save-btn" onclick="probarDisponibilidad()">Probar disponibilidad</button>
                                <span class="schedule-status" id="availStatus"></span>
                            </div>
                            </div>
                        </div>

                        <div class="schedule-actions">
                            <button class="btn btn-green schedule-save-btn" onclick="saveBotTypeConfig()">Guardar tipo de bot</button>
                            <span class="schedule-status" id="botTypeStatus"></span>
                        </div>
                        </div>
                    </div>

                        <!-- Modal Mis Pagos (historial de suscripción) -->
                        <div id="pagosModal" class="modal">
                            <div class="modal-content" style="width: 90%; max-width: 760px;">
                                <span onclick="closeModal('pagosModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                                <h2>${icon('receiptPercent', 'w-4 h-4 inline')} Mis Pagos</h2>
                                <div id="pagosSuscripcionInfo" style="margin-bottom:16px;"></div>
                                <div id="pagosTableWrap" style="overflow-x:auto;">
                                    <table style="width:100%; border-collapse:collapse; font-size:14px;">
                                        <thead>
                                            <tr style="background:#f3f4f6; text-align:left;">
                                                <th style="padding:8px 10px; border-bottom:2px solid #e5e7eb;">Fecha</th>
                                                <th style="padding:8px 10px; border-bottom:2px solid #e5e7eb;">Concepto</th>
                                                <th style="padding:8px 10px; border-bottom:2px solid #e5e7eb;">Período</th>
                                                <th style="padding:8px 10px; border-bottom:2px solid #e5e7eb; text-align:right;">Monto</th>
                                                <th style="padding:8px 10px; border-bottom:2px solid #e5e7eb;">Factura</th>
                                            </tr>
                                        </thead>
                                        <tbody id="pagosTableBody">
                                            <tr><td colspan="5" style="padding:20px; text-align:center; color:#888;">Cargando...</td></tr>
                                        </tbody>
                                    </table>
                                </div>
                                <p style="color:#777; font-size:12px; line-height:1.5; margin-top:12px;">
                                    ${icon('lightBulb', 'w-4 h-4 inline text-yellow-400')} Estos son los pagos que se acreditaron en tu suscripción. Ante cualquier consulta sobre un pago, escribinos por WhatsApp.
                                </p>
                            </div>
                        </div>

                        <!-- Modal Ayuda Google Calendar -->
                        <div id="calendarHelpModal" class="modal">
                            <div class="modal-content" style="width: 90%; max-width: 760px;">
                                <span onclick="closeModal('calendarHelpModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                                <h2>${icon('calendar', 'w-4 h-4 inline')} Cómo conectar tu Google Calendar</h2>
                                <p style="color:#555; font-size:14px; line-height:1.6;">Seguí estos pasos para obtener el <strong>Calendar ID</strong> de tu calendario y compartirlo con el bot.</p>
                                <ol style="font-size:14px; color:#333; line-height:1.7; padding-left:20px;">
                                    <li>Abrí <a href="https://calendar.google.com/" target="_blank" rel="noopener">Google Calendar</a> en tu computadora.</li>
                                    <li>Mirá el lado izquierdo de la pantalla.</li>
                                    <li>Buscá la lista <strong>Mis calendarios</strong>.
                                        <div style="margin:8px 0;"><img src="/img/1cap_mis_calendarios.png" alt="Lista Mis calendarios" style="max-width:100%; border:1px solid #ddd; border-radius:8px;"></div>
                                    </li>
                                    <li>Poné el puntero sobre tu calendario (el que vas a usar para tu negocio).</li>
                                    <li>Hacé clic en los tres puntos.</li>
                                    <li>Entrá en <strong>Configuración y uso compartido</strong>.
                                        <div style="margin:8px 0;"><img src="/img/2cap_mis_calendarios.png" alt="Configuración y uso compartido" style="max-width:100%; border:1px solid #ddd; border-radius:8px;"></div>
                                    </li>
                                    <li>Bajá hasta la parte llamada <strong>Integrar calendario</strong>.</li>
                                    <li>Copiá el texto en <strong>ID del calendario</strong>.
                                        <div style="margin:8px 0;"><img src="/img/4cap_mis_calendarios.png" alt="ID del calendario" style="max-width:100%; border:1px solid #ddd; border-radius:8px;"></div>
                                    </li>
                                    <li>Dale permisos de edición a este email: <code style="background:#f0fdf4; padding:2px 6px; border-radius:4px; color:#166534; font-weight:600;">${process.env.ADMIN_EMAIL || 'la cuenta de Google vinculada al bot'}</code></li>
                                </ol>
                                <p style="color:#777; font-size:12px; line-height:1.5;">${icon('lightBulb', 'w-4 h-4 inline text-yellow-400')} Sin permisos de edición el bot no podrá crear turnos en tu calendario. Pegá el ID copiado en el campo <strong>Calendar ID</strong> de esta página.</p>
                            </div>
                        </div>

                    <!-- Horarios de Atención -->
                    <style>
                        .schedule-section { margin-top: 30px; padding: 20px 24px; border-top: 2px solid var(--border-color); background: var(--bg-box); border-radius: 12px; }
                        .schedule-section h3 { margin: 0 0 6px 0; color: var(--text-main); }
                        .schedule-section .muted { color: var(--text-muted); font-size: 13px; margin: 0 0 16px 0; line-height: 1.5; }
                        .step-toggle { cursor: pointer; user-select: none; }
                        .step-toggle:hover h3 { color: var(--primary-color); }
                        .step-toggle .step-toggle-arrow { transition: transform 0.2s; display: inline-flex; }
                        .online-row { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; }
                        .online-row input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
                        .day-check { width: 17px; height: 17px; cursor: pointer; }
                        .schedule-days { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
                        .schedule-day { flex: 1 1 170px; min-width: 170px; max-width: 250px; border: 1px solid var(--border-color); border-radius: 10px; padding: 12px; background: #fff; }
                        .schedule-day-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-weight: 700; font-size: 14px; color: var(--text-main); }
                        .schedule-day-header label { margin: 0; cursor: pointer; }
                        .schedule-ranges { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
                        .range-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
                        .range-row input[type="time"] { padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; width: 92px; box-sizing: border-box; }
                        .no-ranges { color: #999; font-style: italic; font-size: 13px; }
                        .schedule-actions { margin-top: 18px; display: flex; align-items: center; gap: 14px; }
                        .schedule-status { font-size: 13px; color: #888; }
                        .schedule-save-btn { background: var(--primary-color) !important; color: white !important; border: none !important; }
                        .schedule-save-btn:hover { background: var(--primary-hover) !important; color: white !important; border: none !important; }
                    </style>
                    <div class="schedule-section">
                        <div class="step-toggle" onclick="toggleStep('step2Body', this)" style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                            <div>
                                <div style="display:inline-block; background:#0f6b4f; color:#fff; font-size:11px; font-weight:700; letter-spacing:0.5px; padding:4px 10px; border-radius:4px; margin-bottom:8px;">PASO 2 · CONFIGURÁ LOS HORARIOS DE ATENCIÓN DEL BOT</div>
                                <h3>${icon('clock', 'w-4 h-4 inline')} Horarios de Atención del Bot</h3>
                            </div>
                            <span class="step-toggle-arrow" style="font-size:14px; color:var(--text-muted); transform:rotate(-90deg);">${icon('chevronDown', 'w-4 h-4 inline')}</span>
                        </div>
                        <div class="step-body" id="step2Body" style="display:none;">
                        <p class="muted">Estos son los horarios en los que <strong>el bot atiende y responde mensajes</strong>. Si está <strong>"online 24/7"</strong> responde todo el día, todos los días. Si lo destildás, indicá los días y rangos de horario (hora local de Argentina) en los que querés que responda. Se puede agregar más de un rango por día.<br>
                        <small>${icon('informationCircle', 'w-4 h-4 inline')} <strong>Distinto de</strong> los "Días y Horarios de Atención" de la configuración de Google Calendar, que definen cuándo hay turnos disponibles del negocio.</small></p>
                        <div class="online-row">
                            <input type="checkbox" id="online247" onchange="toggleScheduleEditor()">
                            <label for="online247" style="margin:0;cursor:pointer;">Bot online 24/7</label>
                        </div>
                        <div id="scheduleEditor" style="display:none; margin-top:8px;">
                            <div id="scheduleDays" class="schedule-days"></div>
                        </div>
                        <div class="schedule-actions">
                            <button class="btn btn-green schedule-save-btn" onclick="saveSchedule()">Guardar horarios</button>
                            <span class="schedule-status" id="scheduleStatus"></span>
                        </div>
                        </div>
                    </div>

                    <div class="schedule-section" id="step3Section">
                        <div class="step-toggle" onclick="toggleStep('step3Body', this)" style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                            <div>
                                <div style="display:inline-block; background:#0f6b4f; color:#fff; font-size:11px; font-weight:700; letter-spacing:0.5px; padding:4px 10px; border-radius:4px; margin-bottom:8px;">PASO 3 · EDITÁ TU BOT. COMENZÁ HACIENDO CLIC EN EL BOTÓN "+ HIJO" EN LA COLUMNA DERECHA DE ACCIONES.</div>
                                <h3>${icon('wrenchScrewdriver', 'w-4 h-4 inline')} Editor de Menú</h3>
                            </div>
                            <span class="step-toggle-arrow" style="font-size:14px; color:var(--text-muted); ${hasMenuContent ? '' : 'transform:rotate(-90deg);'}}">${icon('chevronDown', 'w-4 h-4 inline')}</span>
                        </div>
                        <div class="step-body" id="step3Body" style="${hasMenuContent ? '' : 'display:none;'}">
                    <div class="col-toggle-wrap">
                    <button type="button" class="col-toggle-btn" onclick="event.stopPropagation(); toggleColMenu()" title="Columnas visibles">⋮</button>
                    <div class="col-toggle-menu" id="colToggleMenu">
                        <div class="ctm-title">Ver</div>
                        <label><input type="checkbox" checked onchange="toggleCol('precio', this.checked)"> Precio</label>
                        <label><input type="checkbox" checked onchange="toggleCol('pedido', this.checked)"> Pedido</label>
                        <label><input type="checkbox" checked onchange="toggleCol('cant', this.checked)"> Cant.</label>
                        <label><input type="checkbox" checked onchange="toggleCol('fin', this.checked)"> Fin</label>
                        <label><input type="checkbox" checked onchange="toggleCol('datos', this.checked)"> Datos</label>
                        <label><input type="checkbox" checked onchange="toggleCol('archivo', this.checked)"> Archivo</label>
                        <label><input type="checkbox" checked onchange="toggleCol('pagar', this.checked)"> Pagar</label>
                        <label><input type="checkbox" checked onchange="toggleCol('redirigir', this.checked)"> Redirigir</label>
                        <label><input type="checkbox" checked onchange="toggleCol('disp', this.checked)"> Disp.</label>
                    </div>
                    <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Disparador</th>
                                <th>Título</th>
                                <th>Mensaje (Resumen)</th>
                                <th>Acciones</th>
                                <th class="th-mini col-precio">Precio</th>
                                <th class="th-mini col-pedido">Pedido</th>
                                <th class="th-mini col-cant">Cant.</th>
                                <th class="th-mini col-fin">Fin</th>
                                <th class="th-mini col-datos">Datos</th>
                                <th class="th-mini col-archivo">Archivo</th>
                                <th class="th-mini col-pagar">Pagar</th>
                                <th class="th-mini col-redirigir">Redirigir</th>
                                <th class="th-mini col-disp">Disp.</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                    </div>
                    </div>
                        </div>
                    </div>

                    <div class="schedule-section">
                        <div class="step-toggle" onclick="toggleStep('step4Body', this)" style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                            <div>
                                <div style="display:inline-block; background:#0f6b4f; color:#fff; font-size:11px; font-weight:700; letter-spacing:0.5px; padding:4px 10px; border-radius:4px; margin-bottom:8px;">PASO 4 · ACTIVÁ TU BOT EN WHATSAPP</div>
                                <h3>${icon('devicePhoneMobile', 'w-4 h-4 inline')} Conectá tu bot a WhatsApp</h3>
                            </div>
                            <span class="step-toggle-arrow" style="font-size:14px; color:var(--text-muted); transform:rotate(-90deg);">${icon('chevronDown', 'w-4 h-4 inline')}</span>
                        </div>
                        <div class="step-body" id="step4Body" style="display:none;">
                        <div id="step4Status" style="font-size:14px; color:#444; line-height:1.6;">Verificando estado del bot...</div>
                        </div>
                    </div>

                    <!-- Visual Modal -->
                    <div id="visualModal" class="modal">
                        <div class="modal-content" style="width: 80%; max-height: 80%; overflow-y: auto; text-align: center;">
                            <span onclick="closeModal('visualModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2>Estructura Jerárquica</h2>
                            <div class="tree" id="treeContainer"></div>
                        </div>
                    </div>

                    <!-- Add Child Modal -->
                    <div id="addModal" class="modal">
                        <div class="modal-content" style="width: 90%; max-width: 1100px;">
                            <span onclick="closeModal('addModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2 id="addModalTitle">Agregar Nuevo Hijo</h2>
                            
                            <!-- Step 0: Ask if it's an item -->
                            <div id="wizardAsk" style="text-align: center; padding: 30px 20px;">
                                <p id="wizardAskQuestion" style="font-size: 18px; margin-bottom: 30px; color: var(--text-main);">¿Es un item de compra/pedido?</p>
                                <div style="display: flex; gap: 20px; justify-content: center;">
                                    <button id="wizardAskYes" type="button" onclick="startItemWizard()" style="padding: 15px 40px; font-size: 16px; font-weight: 600; background: var(--primary-color); color: white; border: none; border-radius: 8px; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">Sí, es un item</button>
                                    <button id="wizardAskNo" type="button" onclick="showFullForm()" style="padding: 15px 40px; font-size: 16px; font-weight: 600; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">No, formulario completo</button>
                                </div>
                            </div>

                            <!-- Full form (existing behavior) -->
                            <div id="addFullForm" style="display: none;">
                                <div class="modal-body-wrapper">
                                    <div class="form-column">
                                        <div style="background: #e9ecef; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 5px solid #007bff;">
                                            <small style="color: #666; display: block; margin-bottom: 10px;">Vista previa de la relación:</small>
                                            <div id="addPreview" style="font-family: monospace; white-space: pre-wrap; font-size: 13px; max-height: 120px; overflow-y: auto; overflow-x: hidden;"></div>
                                        </div>

                                        <form action="/app/add" method="POST" onsubmit="applyTagsToMessage('add')">
                                            <input type="hidden" name="botId" value="${botId}">
                                            <input type="hidden" id="addParentId" name="parentId">
                                            <input type="hidden" id="addId" name="id">
                                            <div style="display: flex; gap: 15px;">
                                                <div class="form-group" style="flex: 1;">
                                                    <label>Disparador (Número/Letra):</label>
                                                    <input type="text" id="addTrigger" name="trigger" placeholder="ej: 1" required oninput="updatePreview('add')">
                                                </div>
                                                <div class="form-group" style="flex: 1;">
                                                    <label>Precio ($) <small>(Opcional)</small>:</label>
                                                    <input type="text" id="addPrice" name="price" placeholder="ej: 1500" oninput="updatePreview('add')">
                                                </div>
                                            </div>
                                            <div class="form-group" id="addTitleGroup">
                                                <label>Título (En el menú):</label>
                                                <input type="text" id="addTitle" name="title" placeholder="ej: Hablar con Soporte" required oninput="updatePreview('add')">
                                            </div>
                                            <div class="form-group">
                                                <label style="display: flex; align-items: center;">
                                                    Mensaje (Respuesta):
                                                    <span class="info-icon">i
                                                        <span class="tooltip" id="addMessageTooltip">Esta será la respuesta cuando el usuario escriba el disparador. Si deseas agregar un submenú aquí cierra esta ventana y agrega un "hijo" a esta respuesta.</span>
                                                    </span>
                                                </label>
                                                <textarea id="addMessage" name="message" rows="3" placeholder="Mensaje que enviará el bot..." oninput="updatePreview('add')"></textarea>
                                            </div>
                                            <div class="form-group" style="margin-bottom: 20px;" id="cartModuleAdd">
                                                <div style="border:1px solid var(--border-color);border-radius:8px;padding:12px 12px 8px 12px;">
                                                    <div style="font-size:12px;font-weight:700;color:var(--text-main);margin-bottom:8px;">Carrito de compras</div>
                                                    <div class="tags-flex-row" style="display:flex;gap:10px;">
                                                        <div style="flex:1;display:flex;align-items:center;gap:10px;background:#f8f9fa;padding:10px;border-radius:6px;border:1px dashed var(--border-color);">
                                                            <input type="checkbox" id="addIsOrder" onchange="toggleOrderTag('add', '##PEDIDO##')" style="width:16px;height:16px;cursor:pointer;">
                                                            <label for="addIsOrder" style="margin-bottom:0;cursor:pointer;font-size:13px;">¿Crear pedido?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Agrega "1 x Título" al carrito de compras.</span></span></label>
                                                        </div>
                                                        <div style="flex:1;display:flex;align-items:center;gap:10px;background:#eefbff;padding:10px;border-radius:6px;border:1px dashed #bee5eb;">
                                                            <input type="checkbox" id="addIsQty" onchange="toggleOrderTag('add', '##CANTIDAD##')" style="width:16px;height:16px;cursor:pointer;">
                                                            <label for="addIsQty" style="margin-bottom:0;cursor:pointer;font-size:13px;">¿Pedir cantidad?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Pregunta al usuario cuántas unidades quiere llevar.</span></span></label>
                                                        </div>
                                                        <div style="flex:1;display:flex;align-items:center;gap:10px;background:#f3f0ff;padding:10px;border-radius:6px;border:1px dashed #d1d1ff;">
                                                            <input type="checkbox" id="addIsFinal" onchange="toggleOrderTag('add', '##FINALIZAR##')" style="width:16px;height:16px;cursor:pointer;">
                                                            <label for="addIsFinal" style="margin-bottom:0;cursor:pointer;font-size:13px;">¿Finalizar?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Muestra el resumen y vacía el carrito. Combinable con otros tags.</span></span></label>
                                                        </div>
                                                    </div>
                                                    <div class="tags-flex-row" style="display:flex;gap:10px;margin-top:6px;">
                                                        <div style="flex:1;display:flex;align-items:center;gap:10px;background:#fff4e5;padding:10px;border-radius:6px;border:1px dashed #ff9800;">
                                                            <input type="checkbox" id="addIsData" onchange="toggleOrderTag('add', '##DATOS##')" style="width:16px;height:16px;cursor:pointer;">
                                                            <label for="addIsData" style="margin-bottom:0;cursor:pointer;font-size:13px;">Capturar dato y continuar<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Espera que el usuario escriba texto libre (nombre, dirección, etc.).</span></span></label>
                                                        </div>
                                                        <div style="flex:1;display:flex;align-items:center;gap:10px;background:#e8f5e9;padding:10px;border-radius:6px;border:1px dashed #66bb6a;">
                                                            <input type="checkbox" id="addIsArchivo" onchange="toggleOrderTag('add', '##ARCHIVO##')" style="width:16px;height:16px;cursor:pointer;">
                                                            <label for="addIsArchivo" style="margin-bottom:0;cursor:pointer;font-size:13px;">Solicitar archivo<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Espera que el usuario envíe una imagen o archivo.</span></span></label>
                                                        </div>
                                                    </div>
                                                    <div class="tags-flex-row" style="display:flex;gap:10px;margin-top:6px;">
                                                        <div style="flex:1;display:flex;align-items:center;gap:10px;background:#f0fdf4;padding:10px;border-radius:6px;border:1px dashed #86efac;">
                                                            <input type="checkbox" id="addIsPagar" onchange="toggleOrderTag('add', '##PAGAR##')" style="width:16px;height:16px;cursor:pointer;">
                                                            <label for="addIsPagar" style="margin-bottom:0;cursor:pointer;font-size:13px;">Ir a pagar<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Muestra "p. Ir a pagar" cuando hay items en el carrito. Al escribir p va al primer hijo con Finalizar.</span></span></label>
                                                        </div>
                                                        <div style="flex:1;"></div>
                                                    </div>
                                                    </div>
                                            </div>
                                            <div class="form-group" style="margin-bottom: 20px;" id="turnoModuleAdd">
                                                <div style="border:1px solid #86efac;border-radius:8px;padding:12px 12px 8px 12px;background:#f0fdf4;">
                                                    <div style="font-size:12px;font-weight:700;color:#166534;margin-bottom:8px;">Reserva de turno</div>
                                                    <div class="tags-flex-row" style="display:flex;gap:10px;margin-top:6px;">
                                                        <div style="flex:1;display:flex;align-items:center;gap:10px;">
                                                            <input type="checkbox" id="addIsTurno" onchange="toggleOrderTag('add', '##TURNO##')" style="width:16px;height:16px;cursor:pointer;">
                                                            <label for="addIsTurno" style="margin-bottom:0;cursor:pointer;font-size:13px;">Reserva de turno<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Inicia el flujo de reserva: fecha ${icon('arrowRight', 'w-4 h-4 inline')} horario ${icon('arrowRight', 'w-4 h-4 inline')} confirmación (requiere Gestor de Turnos).</span></span></label>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="form-group">
                                                <label>Redirigir a (opcional):</label>
                                                <select id="addRedirigirA" name="redirigirA" style="width:100%;padding:8px;border:1px solid var(--border-color);border-radius:6px;background:white;">
                                                    <option value="">-- Sin redirección --</option>
                                                    ${menuData.filter(n => n.id).map(n => `<option value="${n.id}">${n.title || n.id}${n.price ? ' ($' + n.price + ')' : ''}</option>`).join('')}
                                                </select>
                                                <small style="color:#888;">Al finalizar, irá directamente a este nodo.</small>
                                            </div>
                                            <div class="form-group" style="display:flex;align-items:center;gap:10px;background:#fff3e0;padding:12px;border-radius:6px;border:1px dashed #ffb74d;">
                                                <input type="checkbox" id="addNoDisponible" name="disponible" value="false" style="width:18px;height:18px;cursor:pointer;">
                                                <label for="addNoDisponible" style="margin-bottom:0;cursor:pointer;font-weight:700;color:#e65100;">No disponible (sin stock)</label>
                                            </div>
                                            <button type="submit" class="btn btn-green" style="width: 100%;">Crear Nodo Hijo</button>
                                        </form>
                                    </div>

                                    <div class="chat-column">
                                        <div class="whatsapp-container">
                                            <div class="whatsapp-header">
                                                <div style="width: 30px; height: 30px; background: #ccc; border-radius: 50%;"></div>
                                                <div style="font-weight: bold; font-size: 14px;">Bot WhatsApp</div>
                                            </div>
                                            <div class="whatsapp-body" id="addChatBody">
                                                <!-- Chat content -->
                                            </div>
                                            <div class="wa-footer">
                                                <div class="wa-input"></div>
                                            </div>
                                        </div>
                                        <p style="font-size: 11px; color: #999; text-align: center; margin-top: 10px;">* Simulación de respuesta del bot</p>
                                    </div>
                                </div>
                            </div>

                            <!-- Wizard Container -->
                            <div id="wizardContainer" style="display: none;">
                                <div style="display: flex; gap: 20px; align-items: flex-start;">
                                    <div style="flex: 1;">
                                        <!-- Step indicator -->
                                        <div id="wizardSteps" style="display: flex; gap: 12px; margin-bottom: 20px; align-items: center;">
                                            <span id="wizStepIndicator" style="background: var(--primary-color); color: white; padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 600;">Item #1</span>
                                            <span style="color: var(--text-muted); font-size: 13px;" id="wizItemsCount">0 items agregados</span>
                                        </div>

                                        <!-- Current question -->
                                        <div id="wizQuestion" style="background: var(--bg-box); border: 2px solid var(--border-color); border-radius: 12px; padding: 25px;">
                                            <div id="wizQuestionContent">
                                                <!-- Dynamic content -->
                                            </div>
                                        </div>

                                        <!-- Item list -->
                                        <div id="wizItemsList" style="margin-top: 15px; max-height: 200px; overflow-y: auto;"></div>
                                    </div>

                                    <!-- Wizard preview -->
                                    <div class="chat-column" style="flex: 0 0 35%;">
                                        <div class="whatsapp-container" style="position: sticky; top: 0;">
                                            <div class="whatsapp-header">
                                                <div style="width: 30px; height: 30px; background: #ccc; border-radius: 50%;"></div>
                                                <div style="font-weight: bold; font-size: 14px;">Bot WhatsApp</div>
                                            </div>
                                            <div class="whatsapp-body" id="wizChatBody"></div>
                                            <div class="wa-footer">
                                                <div class="wa-input"></div>
                                            </div>
                                        </div>
                                        <p style="font-size: 11px; color: #999; text-align: center; margin-top: 10px;">* Vista previa del menú</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Edit Modal -->
                    <div id="editModal" class="modal">
                        <div class="modal-content" style="width: 90%; max-width: 1100px;">
                            <span onclick="closeModal('editModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2>Editar Nodo</h2>
                            
                            <div class="modal-body-wrapper">
                                <div class="form-column">
                                    <div style="background: #fff3cd; padding: 10px 12px; border-radius: 5px; margin-bottom: 12px; border-left: 5px solid #ffc107;">
                                        <small style="color: #856404; display: block; margin-bottom: 8px;">Vista previa actual:</small>
                                        <div id="editPreview" style="font-family: monospace; white-space: pre-wrap; font-size: 12px; max-height: 100px; overflow-y: auto; overflow-x: hidden;"></div>
                                    </div>

                                    <form action="/app/save" method="POST" onsubmit="applyTagsToMessage('edit')">
                                        <input type="hidden" name="botId" value="${botId}">
                                        <input type="hidden" id="editIndex" name="index">
                                        <input type="hidden" id="editId" name="id">
                                        <input type="hidden" id="editParentId" name="parentId">
                                        
                                        <div class="form-group" id="strictTriggerGroup" style="display: none; background: #f0fdf4; padding: 10px 12px; border-radius: 6px; border: 1px solid #bbf7d0; margin-bottom: 12px;">
                                            <div style="display: flex; align-items: center; gap: 10px;">
                                                <input type="checkbox" id="editStrictTrigger" name="strictTrigger" value="true" style="width: 18px; height: 18px; cursor: pointer;" onchange="updatePreview('edit')">
                                                <div>
                                                    <label for="editStrictTrigger" style="margin-bottom: 2px; cursor: pointer; color: #166534; font-size: 13px; font-weight: 700;">Activar bot solo con disparador exacto</label>
                                                    <p style="margin: 0; font-size: 11px; color: #15803d;">Si está marcado, el bot solo responderá si el usuario escribe exactamente el disparador inicial. Si no, responderá a cualquier palabra.</p>
                                                </div>
                                            </div>
                                        </div>

                                        <div style="display: flex; gap: 15px;" id="editTriggerGroup">
                                            <div class="form-group" style="flex: 1;">
                                                <label>Disparador (Número/Letra):</label>
                                                <input type="text" id="editTrigger" name="trigger" required oninput="updatePreview('edit')">
                                            </div>
                                            <div class="form-group" style="flex: 1;">
                                                <label>Precio ($) <small>(Opcional)</small>:</label>
                                                <input type="text" id="editPrice" name="price" oninput="updatePreview('edit')">
                                            </div>
                                        </div>
                                        <div class="form-group" id="editTitleGroup">
                                            <label>Título (En el menú):</label>
                                            <input type="text" id="editTitle" name="title" required oninput="updatePreview('edit')">
                                        </div>
                                        <div class="form-group">
                                            <label style="display: flex; align-items: center;">
                                                Mensaje (Respuesta):
                                                <span class="info-icon">i
                                                    <span class="tooltip" id="editMessageTooltip">Esta será la respuesta cuando el usuario escriba el disparador. Si deseas agregar un submenú aquí, en el mensaje agrega 'Elige una opción:' y luego cierra esta ventana y agrega un "hijo" a esta respuesta.</span>
                                                </span>
                                            </label>
                                            <textarea id="editMessage" name="message" rows="4" oninput="updatePreview('edit')"></textarea>
                                        </div>
                                        <div class="form-group" id="editTagsGroup" style="margin-bottom: 12px;">
                                            <div style="border:1px solid var(--border-color);border-radius:8px;padding:8px 10px 6px 10px;margin:8px;" id="cartModuleEdit">
                                                <div style="font-size:12px;font-weight:700;color:var(--text-main);margin-bottom:6px;">Carrito de compras</div>
                                                <div class="tags-flex-row" style="display:flex;gap:8px;">
                                                    <div style="flex:1;display:flex;align-items:center;gap:8px;background:#fff3cd;padding:6px 8px;border-radius:6px;border:1px dashed #ffc107;">
                                                    <input type="checkbox" id="editIsOrder" onchange="toggleOrderTag('edit', '##PEDIDO##')" style="width:16px;height:16px;cursor:pointer;">
                                                    <label for="editIsOrder" style="margin-bottom:0;cursor:pointer;color:#856404;font-size:13px;">¿Crear pedido?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Agrega "1 x Título" al carrito de compras.</span></span></label>
                                                </div>
                                                <div style="flex:1;display:flex;align-items:center;gap:8px;background:#eefbff;padding:6px 8px;border-radius:6px;border:1px dashed #bee5eb;">
                                                    <input type="checkbox" id="editIsQty" onchange="toggleOrderTag('edit', '##CANTIDAD##')" style="width:16px;height:16px;cursor:pointer;">
                                                    <label for="editIsQty" style="margin-bottom:0;cursor:pointer;color:#0c5460;font-size:13px;">¿Pedir cantidad?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Pregunta al usuario cuántas unidades quiere llevar.</span></span></label>
                                                </div>
                                                <div style="flex:1;display:flex;align-items:center;gap:8px;background:#f3f0ff;padding:6px 8px;border-radius:6px;border:1px dashed #d1d1ff;">
                                                    <input type="checkbox" id="editIsFinal" onchange="toggleOrderTag('edit', '##FINALIZAR##')" style="width:16px;height:16px;cursor:pointer;">
                                                    <label for="editIsFinal" style="margin-bottom:0;cursor:pointer;color:#5227cc;font-size:13px;">¿Finalizar?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Muestra el resumen y vacía el carrito. Combinable con otros tags.</span></span></label>
                                                    </div>
                                                </div>
                                                <div class="tags-flex-row" style="display:flex;gap:8px;margin-top:6px;">
                                                    <div style="flex:1;display:flex;align-items:center;gap:8px;background:#fff4e5;padding:6px 8px;border-radius:6px;border:1px dashed #ff9800;">
                                                        <input type="checkbox" id="editIsData" onchange="toggleOrderTag('edit', '##DATOS##')" style="width:16px;height:16px;cursor:pointer;">
                                                        <label for="editIsData" style="margin-bottom:0;cursor:pointer;color:#856404;font-size:13px;">¿Capturar dato?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Espera que el usuario escriba texto libre (nombre, dirección, etc.).</span></span></label>
                                                    </div>
                                                    <div style="flex:1;display:flex;align-items:center;gap:8px;background:#e8f5e9;padding:6px 8px;border-radius:6px;border:1px dashed #66bb6a;">
                                                        <input type="checkbox" id="editIsArchivo" onchange="toggleOrderTag('edit', '##ARCHIVO##')" style="width:16px;height:16px;cursor:pointer;">
                                                        <label for="editIsArchivo" style="margin-bottom:0;cursor:pointer;color:#2e7d32;font-size:13px;">¿Solicitar archivo?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Espera que el usuario envíe una imagen o archivo.</span></span></label>
                                                    </div>
                                                </div>
                                                <div class="tags-flex-row" style="display:flex;gap:8px;margin-top:6px;">
                                                    <div style="flex:1;display:flex;align-items:center;gap:8px;background:#f0fdf4;padding:6px 8px;border-radius:6px;border:1px dashed #86efac;">
                                                        <input type="checkbox" id="editIsPagar" onchange="toggleOrderTag('edit', '##PAGAR##')" style="width:16px;height:16px;cursor:pointer;">
                                                        <label for="editIsPagar" style="margin-bottom:0;cursor:pointer;color:#166534;font-size:13px;">Ir a pagar<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Muestra "p. Ir a pagar" cuando hay items en el carrito. Al escribir p va al primer hijo con Finalizar.</span></span></label>
                                                    </div>
                                                    <div style="flex:1;"></div>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="form-group" style="margin-bottom: 12px;" id="turnoModuleEdit">
                                            <div style="border:1px solid #86efac;border-radius:8px;padding:8px 10px 6px 10px;background:#f0fdf4;">
                                                <div style="font-size:12px;font-weight:700;color:#166534;margin-bottom:6px;">Reserva de turno</div>
                                                <div class="tags-flex-row" style="display:flex;gap:8px;margin-top:6px;">
                                                    <div style="flex:1;display:flex;align-items:center;gap:8px;">
                                                        <input type="checkbox" id="editIsTurno" onchange="toggleOrderTag('edit', '##TURNO##')" style="width:16px;height:16px;cursor:pointer;">
                                                        <label for="editIsTurno" style="margin-bottom:0;cursor:pointer;color:#166534;font-size:13px;">Reserva de turno<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Inicia el flujo de reserva: fecha ${icon('arrowRight', 'w-4 h-4 inline')} horario ${icon('arrowRight', 'w-4 h-4 inline')} confirmación (requiere Gestor de Turnos).</span></span></label>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="form-group">
                                            <label>Redirigir a (opcional):</label>
                                            <select id="editRedirigirA" name="redirigirA" style="width:100%;padding:8px;border:1px solid var(--border-color);border-radius:6px;background:white;">
                                                <option value="">-- Sin redirección --</option>
                                                ${menuData.filter(n => n.id).map(n => `<option value="${n.id}">${n.title || n.id}${n.price ? ' ($' + n.price + ')' : ''}</option>`).join('')}
                                            </select>
                                            <small style="color:#888;">Al finalizar, irá directamente a este nodo.</small>
                                        </div>
                                        <div class="form-group" style="display:flex;align-items:center;gap:10px;background:#fff3e0;padding:8px 10px;border-radius:6px;border:1px dashed #ffb74d;margin-bottom:12px;">
                                            <input type="checkbox" id="editNoDisponible" name="disponible" value="false" style="width:16px;height:16px;cursor:pointer;">
                                            <label for="editNoDisponible" style="margin-bottom:0;cursor:pointer;font-weight:700;color:#e65100;font-size:13px;">No disponible (sin stock)</label>
                                        </div>
                                        <button type="submit" class="btn btn-green" style="width: 100%;">Guardar Cambios</button>
                                    </form>
                                </div>

                                <div class="chat-column">
                                    <div class="whatsapp-container">
                                        <div class="whatsapp-header">
                                            <div style="width: 30px; height: 30px; background: #ccc; border-radius: 50%;"></div>
                                            <div style="font-weight: bold; font-size: 14px;">Bot WhatsApp</div>
                                        </div>
                                        <div class="whatsapp-body" id="editChatBody">
                                            <!-- Chat content -->
                                        </div>
                                        <div class="wa-footer">
                                            <div class="wa-input"></div>
                                        </div>
                                    </div>
                                    <p style="font-size: 11px; color: #999; text-align: center; margin-top: 10px;">* Simulación de respuesta del bot</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div id="deleteConfirmModal" class="modal">
                        <div class="modal-content" style="width: 450px; text-align: center; padding: 40px;">
                            <div style="margin-bottom: 25px;">
                                <div style="width: 60px; height: 60px; background: #fff5f5; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;">
                                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#dc3545" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                                </div>
                                <h3 id="deleteConfirmTitle" style="margin: 0 0 10px; color: #333;">¿Eliminar esta opción?</h3>
                                <p id="deleteConfirmMessage" style="color: #666; font-size: 14px; line-height: 1.5; margin: 0;">¿Estás seguro de que deseas borrar esta fila?</p>
                            </div>
                            <div style="display: flex; gap: 12px; justify-content: center;">
                                <button type="button" onclick="closeModal('deleteConfirmModal')" class="btn" style="flex: 1; padding: 12px;">Cancelar</button>
                                <button type="button" id="deleteConfirmBtn" class="btn btn-red" style="flex: 1; padding: 12px;">Eliminar</button>
                            </div>
                        </div>
                    </div>

                    <!-- Support Bot -->
                    <div class="support-toggle minimized" id="supportToggle" onclick="toggleSupport()">
                        <span class="support-toggle-min" id="supportToggleMin" onclick="event.stopPropagation(); minimizeSupport()" title="Minimizar">−</span>
                        <img id="botLogoSupport" src="/img/wamenu_square.png" alt="Asistente" style="width: 40px; height: 40px; object-fit: contain; display: block;">
                        <span class="label">te ayudo?</span>
                    </div>
                    <div class="support-modal" id="supportModal">
                        <div class="support-header">
                            <div>
                                <h4>Asistente del Editor</h4>
                                <div class="sub">Consultá cómo usar el editor</div>
                            </div>
                            <div style="display:flex; align-items:center; gap:6px;">
                                <button onclick="minimizeSupport()" title="Minimizar" style="background:none;border:none;color:white;font-size:18px;cursor:pointer;padding:0 4px;">&minus;</button>
                                <button onclick="toggleSupport()" title="Cerrar" style="background:none;border:none;color:white;font-size:20px;cursor:pointer;">&times;</button>
                            </div>
                        </div>
                        <div class="support-body" id="supportBody">
                            <div class="sb-bubble bot">¡Hola! Soy el asistente del editor de menú. Haceme cualquier pregunta sobre cómo crear o modificar el menú de tu bot de WhatsApp. ${icon('faceSmile', 'w-4 h-4 inline text-yellow-400')}</div>
                        </div>
                        <div class="support-footer">
                            <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
                                <div class="suggestion-chips" id="suggestionChips">
                                    <span class="chip" onclick="sendSuggestion(this)">¿Cómo crear submenús?</span>
                                    <span class="chip" onclick="sendSuggestion(this)">¿Qué son los tags?</span>
                                    <span class="chip" onclick="sendSuggestion(this)">¿Cómo pedir datos?</span>
                                </div>
                                <div style="display:flex;gap:8px;">
                                    <input type="text" id="supportInput" placeholder="Escribí tu pregunta..." onkeydown="if(event.key==='Enter') sendSupportMessage()">
                                    <button id="supportSendBtn" onclick="sendSupportMessage()">${icon('chevronRight', 'w-4 h-4 inline')}</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <script>
                        const menuData = ${JSON.stringify(menuData)};
                        const botId = "${botId}";
                        let currentParent = null;

                        // --- Horarios de Atención ---
                        const scheduleConfig = ${JSON.stringify(scheduleConfig)};
                        const DAY_KEYS = ['1', '2', '3', '4', '5', '6', '0'];
                        const DAY_LABELS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

                        function rangeRowHtml(desde, hasta) {
                            return '<div class="range-row">' +
                                '<span>De</span>' +
                                '<input type="time" class="range-from" value="' + (desde || '') + '">' +
                                '<span>a</span>' +
                                '<input type="time" class="range-to" value="' + (hasta || '') + '">' +
                                '<button type="button" class="btn btn-red" onclick="removeRange(this)" style="padding:4px 8px;">X</button>' +
                                '</div>';
                        }

                        function renderSchedule() {
                            document.getElementById('online247').checked = scheduleConfig.online24_7 !== false;
                            DAY_KEYS.forEach(function(k, i) {
                                const ranges = scheduleConfig.horarios[k] || [];
                                const day = document.createElement('div');
                                day.className = 'schedule-day';
                                day.innerHTML =
                                    '<div class="schedule-day-header">' +
                                        '<input type="checkbox" class="day-check" id="day_' + k + '" ' + (ranges.length ? 'checked' : '') + ' onchange="toggleDay(\\'' + k + '\\')">' +
                                        '<label for="day_' + k + '">' + DAY_LABELS[i] + '</label>' +
                                    '</div>' +
                                    '<div id="ranges_' + k + '" class="schedule-ranges">' +
                                        (ranges.length ? ranges.map(function(r) { return rangeRowHtml(r.desde, r.hasta); }).join('') : '<span class="no-ranges">Cerrado</span>') +
                                    '</div>' +
                                    '<button type="button" class="btn" onclick="addRange(\\'' + k + '\\')" style="padding:6px 12px;font-size:12px;">+ Rango</button>';
                                document.getElementById('scheduleDays').appendChild(day);
                            });
                            toggleScheduleEditor();
                        }

                        function toggleScheduleEditor() {
                            const open = !document.getElementById('online247').checked;
                            document.getElementById('scheduleEditor').style.display = open ? 'block' : 'none';
                        }

                        function toggleDay(k) {
                            const box = document.getElementById('day_' + k);
                            const container = document.getElementById('ranges_' + k);
                            if (!box.checked) {
                                container.innerHTML = '<span class="no-ranges">Cerrado</span>';
                                return;
                            }
                            if (container.querySelector('.range-row')) return;
                            addRange(k);
                        }

                        function addRange(k) {
                            document.getElementById('day_' + k).checked = true;
                            const container = document.getElementById('ranges_' + k);
                            if (container.querySelector('.no-ranges')) container.innerHTML = '';
                            container.insertAdjacentHTML('beforeend', rangeRowHtml('', ''));
                        }

                        function removeRange(btn) {
                            const row = btn.closest('.range-row');
                            const container = row.parentNode;
                            row.remove();
                            if (!container.querySelector('.range-row')) {
                                container.innerHTML = '<span class="no-ranges">Cerrado</span>';
                                const k = container.id.replace('ranges_', '');
                                document.getElementById('day_' + k).checked = false;
                            }
                        }

                        function saveSchedule() {
                            const status = document.getElementById('scheduleStatus');
                            const horarios = {};
                            DAY_KEYS.forEach(function(k) {
                                if (!document.getElementById('day_' + k).checked) return;
                                const ranges = [];
                                document.querySelectorAll('#ranges_' + k + ' .range-row').forEach(function(row) {
                                    const desde = row.querySelector('.range-from').value;
                                    const hasta = row.querySelector('.range-to').value;
                                    if (desde && hasta) ranges.push({ desde: desde, hasta: hasta });
                                });
                                if (ranges.length) horarios[k] = ranges;
                            });

                            status.textContent = 'Guardando...';
                            fetch('/app/api/schedule', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    botId: botId,
                                    online_24_7: document.getElementById('online247').checked,
                                    horarios: horarios
                                })
                            }).then(function(r) { return r.json(); }).then(function(d) {
                                if (d.success) {
                                    scheduleConfig.online24_7 = document.getElementById('online247').checked;
                                    scheduleConfig.horarios = horarios;
                                    status.innerHTML = '${icon('checkCircle', 'w-4 h-4 inline text-green-400')} Horarios guardados';
                                } else {
                                    status.innerHTML = '${icon('xCircle', 'w-4 h-4 inline text-red-400')} ' + (d.error || 'Error al guardar');
                                }
                                setTimeout(function() { status.textContent = ''; }, 3000);
                            }).catch(function() {
                                status.innerHTML = '${icon('xCircle', 'w-4 h-4 inline text-red-400')} Error de conexión';
                                setTimeout(function() { status.textContent = ''; }, 3000);
                            });
                        }

                        renderSchedule();
                        // --- Fin Horarios ---

                        // --- Tipo de Bot + Google Calendar ---
                        const BOT_TYPE_LABELS = { '1': 'Lunes', '2': 'Martes', '3': 'Miércoles', '4': 'Jueves', '5': 'Viernes', '6': 'Sábado', '0': 'Domingo' };
                        const BOT_TYPE_ORDER = ['1', '2', '3', '4', '5', '6', '0'];
                        let botType = 'CARRITO';
                        let calendarConfig = { calendar_id: '', time_zone: 'America/Argentina/Buenos_Aires', slot_duration_minutes: 30, business_hours: {}, min_notice_hours: 2, reminder_enabled: false, reminder_hours_before: 24, waitlist_enabled: false, mis_turnos_enabled: true, mis_turnos_cancelar: true, recordatorio_cancelar: true, reprogramar_enabled: true };

                        function renderBusinessHours() {
                            const body = document.getElementById('businessHoursBody');
                            if (!body) return;
                            const bh = calendarConfig.business_hours || {};
                            body.innerHTML = BOT_TYPE_ORDER.map(function(k) {
                                const ranges = bh[k] || [];
                                const r = ranges[0] || { desde: '09:00', hasta: '18:00' };
                                return '<tr>' +
                                    '<td style="padding:6px 8px; font-weight:600;">' + BOT_TYPE_LABELS[k] + '</td>' +
                                    '<td style="padding:6px 8px;"><input type="checkbox" id="bh_day_' + k + '" ' + (ranges.length ? 'checked' : '') + ' style="width:17px;height:17px;cursor:pointer;"></td>' +
                                    '<td style="padding:6px 8px;"><input type="time" id="bh_from_' + k + '" value="' + r.desde + '" style="padding:6px 8px;border:1px solid var(--border-color);border-radius:6px;"></td>' +
                                    '<td style="padding:6px 8px;"><input type="time" id="bh_to_' + k + '" value="' + r.hasta + '" style="padding:6px 8px;border:1px solid var(--border-color);border-radius:6px;"></td>' +
                                    '</tr>';
                            }).join('');
                        }

                        function collectBusinessHours() {
                            const bh = {};
                            BOT_TYPE_ORDER.forEach(function(k) {
                                const box = document.getElementById('bh_day_' + k);
                                if (!box || !box.checked) return;
                                const desde = document.getElementById('bh_from_' + k).value;
                                const hasta = document.getElementById('bh_to_' + k).value;
                                if (desde && hasta) bh[k] = [{ desde: desde, hasta: hasta }];
                            });
                            return bh;
                        }

                        let prevBotType = null;

                        function onBotTypeChange() {
                            const type = document.getElementById('botTypeInput').value;
                            document.getElementById('calendarSection').style.display = type === 'TURNOS' ? 'block' : 'none';
                            // Aviso al usuario si pasa de TURNOS a otro tipo (afecta recordatorios)
                            if (prevBotType === 'TURNOS' && type !== 'TURNOS') {
                                const st = document.getElementById('botTypeStatus');
                                if (st) st.innerHTML = '<span style="color:#d32f2f;">${icon('exclamationTriangle', 'w-4 h-4 inline')} Tu bot es de turnos. Si cambiás el tipo, los recordatorios y la lista de espera dejarán de funcionar.</span>';
                            } else if (type === 'TURNOS') {
                                const st = document.getElementById('botTypeStatus');
                                if (st) st.textContent = '';
                            }
                            prevBotType = type;
                            toggleCartModules();
                            updateWizardAsk();
                        }

                        function updateWizardAsk() {
                            const el = document.getElementById('wizardAskQuestion');
                            const yes = document.getElementById('wizardAskYes');
                            const no = document.getElementById('wizardAskNo');
                            if (!el) return;
                            const type = document.getElementById('botTypeInput').value;
                            if (type === 'TURNOS') {
                                el.textContent = '¿Es un servicio/turno a reservar?';
                                yes.textContent = 'Sí, es un turno';
                                no.textContent = 'No, formulario completo';
                            } else if (type === 'FAQ') {
                                el.textContent = '¿Es una respuesta de consulta (FAQ)?';
                                yes.textContent = 'Sí, es una consulta';
                                no.textContent = 'No, formulario completo';
                            } else {
                                el.textContent = '¿Es un item de compra/pedido?';
                                yes.textContent = 'Sí, es un item';
                                no.textContent = 'No, formulario completo';
                            }
                        }

                        function toggleCartModules() {
                            const type = document.getElementById('botTypeInput') ? document.getElementById('botTypeInput').value : 'CARRITO';
                            const showCart = type === 'CARRITO';
                            const showTurno = type === 'TURNOS';
                            const cartAdd = document.getElementById('cartModuleAdd');
                            if (cartAdd) cartAdd.style.display = showCart ? '' : 'none';
                            const cartEdit = document.getElementById('cartModuleEdit');
                            if (cartEdit) cartEdit.style.display = showCart ? '' : 'none';
                            const turnoAdd = document.getElementById('turnoModuleAdd');
                            if (turnoAdd) turnoAdd.style.display = showTurno ? '' : 'none';
                            const turnoEdit = document.getElementById('turnoModuleEdit');
                            if (turnoEdit) turnoEdit.style.display = showTurno ? '' : 'none';
                        }

                        function loadBotConfig() {
                            fetch('/app/api/bot-config?botId=' + encodeURIComponent(botId))
                                .then(function(r) { return r.json(); })
                                .then(function(d) {
                                    if (!d || d.error) return;
                                    botType = d.bot_type || 'CARRITO';
                                    calendarConfig = d.calendar_config || calendarConfig;
                                    document.getElementById('botTypeInput').value = botType;
                                    document.getElementById('calendarIdInput').value = calendarConfig.calendar_id || '';
                                    document.getElementById('slotDurationInput').value = calendarConfig.slot_duration_minutes || 30;
                                    document.getElementById('minNoticeInput').value = calendarConfig.min_notice_hours || 0;
                                    document.getElementById('reminderEnabledInput').checked = calendarConfig.reminder_enabled === true || calendarConfig.reminder_enabled === 'true';
                                    document.getElementById('reminderHoursInput').value = calendarConfig.reminder_hours_before || 24;
                                    document.getElementById('waitlistEnabledInput').checked = calendarConfig.waitlist_enabled === true || calendarConfig.waitlist_enabled === 'true';
                                    document.getElementById('misTurnosEnabledInput').checked = calendarConfig.mis_turnos_enabled !== false;
                                    document.getElementById('misTurnosCancelarInput').checked = calendarConfig.mis_turnos_cancelar !== false;
                                    document.getElementById('recordatorioCancelarInput').checked = calendarConfig.recordatorio_cancelar !== false;
                                    document.getElementById('reprogramarEnabledInput').checked = calendarConfig.reprogramar_enabled !== false;
                                    if (calendarConfig.calendar_id) {
                                        const btn = document.getElementById('calendarBtn');
                                        if (btn) btn.href = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(calendarConfig.calendar_id);
                                    }
                                    renderBusinessHours();
                                    onBotTypeChange();
                                    toggleCartModules();
                                    updateWizardAsk();
                                })
                                .catch(function(e) { console.error('Error cargando bot config:', e); });
                        }

                        function saveBotTypeConfig() {
                            const status = document.getElementById('botTypeStatus');
                            if (!status) return;
                            status.textContent = 'Guardando...';
                            const payload = {
                                botId: botId,
                                bot_type: document.getElementById('botTypeInput').value,
                                calendar_config: {
                                    calendar_id: document.getElementById('calendarIdInput').value.trim(),
                                    time_zone: 'America/Argentina/Buenos_Aires',
                                    slot_duration_minutes: parseInt(document.getElementById('slotDurationInput').value, 10) || 30,
                                    min_notice_hours: parseInt(document.getElementById('minNoticeInput').value, 10) || 0,
                                    reminder_enabled: document.getElementById('reminderEnabledInput').checked,
                                    reminder_hours_before: parseInt(document.getElementById('reminderHoursInput').value, 10) || 24,
                                    waitlist_enabled: document.getElementById('waitlistEnabledInput').checked,
                                    mis_turnos_enabled: document.getElementById('misTurnosEnabledInput').checked,
                                    mis_turnos_cancelar: document.getElementById('misTurnosCancelarInput').checked,
                                    recordatorio_cancelar: document.getElementById('recordatorioCancelarInput').checked,
                                    reprogramar_enabled: document.getElementById('reprogramarEnabledInput').checked,
                                    business_hours: collectBusinessHours()
                                }
                            };
                            fetch('/app/api/bot-config', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            }).then(function(r) { return r.json(); }).then(function(d) {
                                if (d.success) {
                                    botType = payload.bot_type;
                                    calendarConfig = payload.calendar_config;
                                    status.innerHTML = '${icon('checkCircle', 'w-4 h-4 inline text-green-400')} Tipo de bot guardado';
                                } else {
                                    status.innerHTML = '${icon('xCircle', 'w-4 h-4 inline text-red-400')} ' + (d.error || 'Error al guardar');
                                }
                                setTimeout(function() { status.textContent = ''; }, 3000);
                            }).catch(function() {
                                status.innerHTML = '${icon('xCircle', 'w-4 h-4 inline text-red-400')} Error de conexión';
                                setTimeout(function() { status.textContent = ''; }, 3000);
                            });
                        }

                        function probarDisponibilidad() {
                            const status = document.getElementById('availStatus');
                            if (!status) return;
                            status.textContent = 'Consultando...';
                            fetch('/app/api/bot-config/disponibilidad?botId=' + encodeURIComponent(botId))
                                .then(function(r) { return r.json(); })
                                .then(function(d) {
                                    if (d.error) {
                                        status.innerHTML = '${icon('xCircle', 'w-4 h-4 inline text-red-400')} ' + d.error;
                                    } else if (!d.slots || d.slots.length === 0) {
                                        status.innerHTML = '${icon('faceFrown', 'w-4 h-4 inline text-yellow-400')} Sin horarios disponibles para hoy (' + d.fecha + ')';
                                    } else {
                                        status.innerHTML = '${icon('checkCircle', 'w-4 h-4 inline text-green-400')} ' + d.slots.length + ' horarios disponibles hoy: ' + d.slots.map(function(s) { return s.label; }).join(', ');
                                    }
                                    setTimeout(function() { status.textContent = ''; }, 8000);
                                })
                                .catch(function() {
                                    status.innerHTML = '${icon('xCircle', 'w-4 h-4 inline text-red-400')} Error de conexión';
                                    setTimeout(function() { status.textContent = ''; }, 3000);
                                });
                        }

                        loadBotConfig();
                        // --- Fin Tipo de Bot ---

${helpGuideJS}
                        drawRobot('botLogoDash');

                        function checkBotStatus() {
                            const dot = document.getElementById('statusDot');
                            const label = document.getElementById('statusLabel');
                            const help = document.getElementById('statusHelp');
                            if (!dot || !label) return;
                            fetch('/app/api/bot/status/${botId}')
                                .then(r => r.json())
                                .then(data => {
                                    const labels = {
                                        connected: 'Conectado',
                                        waiting_start: 'Sin iniciar',
                                        starting: 'Iniciando',
                                        connecting: 'Conectando',
                                        qr_ready: 'Esperando QR',
                                        disconnected: 'Desconectado',
                                        logged_out: 'Sesión cerrada',
                                        stopped_inactivity: 'Detenido',
                                        timeout_qr: 'QR expiró',
                                        suspended_subscription: 'Detenido (suscripción)',
                                        error: 'Error'
                                    };
                                    const tips = {
                                        waiting_start: 'El bot está configurado pero aún no se inició. Hacé clic en "Iniciar Bot" para conectarlo a WhatsApp.',
                                        disconnected: 'La conexión con WhatsApp se perdió. Iniciá el bot nuevamente para restablecerla.',
                                        logged_out: 'La sesión de WhatsApp fue cerrada. Escaneá el código QR nuevamente para reconectar.',
                                        stopped_inactivity: 'El bot se detuvo automáticamente por inactividad. Iniciarlo cuando lo necesites.',
                                        timeout_qr: 'El código QR expiró sin ser escaneado. Mostrá uno nuevo y escanealo con tu teléfono.',
                                        suspended_subscription: 'El bot está pausado porque la suscripción está vencida. Regularizá el pago para reactivarlo.',
                                        error: 'Ocurrió un error en la conexión. Intentá iniciar el bot nuevamente.'
                                    };
                                    const cls = data.status === 'connected' ? 'on' :
                                        data.status === 'error' || data.status === 'logged_out' || data.status === 'timeout_qr' ? 'error' : 'off';
                                    dot.className = 'status-dot ' + cls;
                                    label.textContent = labels[data.status] || data.status;
                                    if (help) {
                                        const tip = tips[data.status];
                                        if (tip) {
                                            help.style.display = 'inline-block';
                                            help.querySelector('.status-help-tip').textContent = tip;
                                        } else {
                                            help.style.display = 'none';
                                        }
                                    }
                                    const step4 = document.getElementById('step4Status');
                                    if (step4) {
                                        const sub = data.suscripcion;
                                        if (sub && (sub.estado === 'gracia' || sub.estado === 'suspendida')) {
                                            const fechaSusp = sub.fechaSuspension ? new Date(sub.fechaSuspension).toLocaleDateString('es-AR') : '';
                                            if (sub.estado === 'gracia') {
                                                step4.innerHTML = '<div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:12px 16px;color:#9a3412;font-size:0.9rem;">${icon('exclamationTriangle', 'w-4 h-4 inline text-yellow-400')} <strong>Tu suscripción venció.</strong> Podés seguir editando tu menú, pero el bot no puede activarse hasta regularizar el pago. El servicio se suspenderá el <strong>' + fechaSusp + '</strong>.</div>';
                                            } else {
                                                step4.innerHTML = '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;color:#991b1b;font-size:0.9rem;">${icon('noSymbol', 'w-4 h-4 inline text-red-400')} <strong>Tu suscripción está suspendida.</strong> Regularizá el pago para volver a usar tu bot.</div>';
                                            }
                                        } else if (data.status === 'connected') {
                                            step4.innerHTML = '<span style="color:#2e7d32; font-weight:700;">${icon('checkCircle', 'w-4 h-4 inline text-green-400')} Tu bot se encuentra activo</span>';
                                        } else {
                                            step4.innerHTML = 'Ahora abre la cuenta de <strong>WhatsApp</strong> en la que va a trabajar tu bot asistente. Hacé clic en los <strong>3 puntitos</strong>, elegí <strong>"Vincular dispositivos"</strong> y escaneá el QR de tu bot ingresando acá: <a href="/app/qr" target="_blank" style="color:#0f6b4f; font-weight:700;">${icon('devicePhoneMobile', 'w-4 h-4 inline')} Link de WhatsApp QR</a> y esperá a que diga <strong>activo</strong>. En ese momento el bot ya estará activo y cualquier cambio que realices en la tabla de edición de tu bot se verá reflejado en el bot online. ¡Muchos éxitos! ${icon('sparkles', 'w-4 h-4 inline text-purple-400')}';
                                        }
                                    }
                                })
                                .catch(function(){ dot.className = 'status-dot off'; label.textContent = 'Sin conexión'; });
                        }
                        checkBotStatus();
                        setInterval(checkBotStatus, 10000);

                        function updateTitleState(type, isData) {
                            const idEl = document.getElementById(type + 'Id');
                            const isRoot = idEl && idEl.value === 'root';
                            if (isRoot) return;
                        }
                        
                        function buildTree(parentId) {
                            const children = menuData.filter(n => n.parentId === parentId);
                            if (children.length === 0) return '';
                            
                            // Ordenar por trigger (numérico si es posible)
                            children.sort((a, b) => {
                                const ta = parseFloat(a.trigger) || 0;
                                const tb = parseFloat(b.trigger) || 0;
                                if (ta !== tb) return ta - tb;
                                return String(a.trigger).localeCompare(String(b.trigger));
                            });

                            let html = '<ul>';
                            children.forEach(child => {
                                html += '<li>';
                                html += '<div><b>' + child.trigger + '. ' + child.title + (child.price ? ' ($' + child.price + ')' : '') + '</b></div>';
                                html += buildTree(child.id);
                                html += '</li>';
                            });
                            html += '</ul>';
                            return html;
                        }

                        function showVisual() {
                            const container = document.getElementById('treeContainer');
                            const hasNodes = menuData.some(n => n.parentId === 'root');
                            if (!hasNodes) {
                                container.innerHTML = '<p style="color:#888; font-size:14px; text-align:center; padding:20px;">La estructura del bot aparecerá aquí debajo. Comienza a editarlo primero.</p>';
                            } else {
                                container.innerHTML = buildTree('root');
                            }
                            document.getElementById('visualModal').style.display = "block";
                        }

                        // --- Mis Pagos ---
                        function fmtMoney(n) {
                            return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(Number(n) || 0);
                        }
                        function fmtFechaPago(iso) {
                            if (!iso) return '-';
                            const d = new Date(iso);
                            if (isNaN(d.getTime())) return '-';
                            return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
                        }
                        function fmtPeriodo(f) {
                            if (!f) return '-';
                            const s = String(f);
                            return s.length === 8 ? s.slice(0, 4) + '/' + s.slice(4, 6) + '/' + s.slice(6, 8) : s;
                        }

                        function showMisPagos() {
                            const modal = document.getElementById('pagosModal');
                            const info = document.getElementById('pagosSuscripcionInfo');
                            const tbody = document.getElementById('pagosTableBody');
                            modal.style.display = "block";
                            info.innerHTML = '<p style="color:#888;">Consultando tus pagos...</p>';
                            tbody.innerHTML = '<tr><td colspan="5" style="padding:20px; text-align:center; color:#888;">Cargando...</td></tr>';

                            fetch('/app/api/mis-pagos')
                                .then(function(r) { if (!r.ok) throw new Error('Error de autenticación'); return r.json(); })
                                .then(function(data) {
                                    const facturas = data.facturas || [];
                                    if (facturas.length === 0) {
                                        info.innerHTML = '<p style="color:#777; font-size:14px; background:#f8f9fa; padding:12px 16px; border-radius:8px;">Aún no hay pagos registrados para tu suscripción. Cuando realices tu primer pago, aparecerá acá.</p>';
                                    } else {
                                        info.innerHTML = '<p style="color:#555; font-size:14px; background:#f0fdf4; padding:12px 16px; border-radius:8px;">Se encontraron <strong>' + facturas.length + '</strong> pago(s) acreditado(s) en tu suscripción.</p>';
                                    }

                                    tbody.innerHTML = facturas.map(function(f) {
                                        const tipo = f.tipo === 'INICIAL' ? 'Suscripción inicial' : 'Renovación';
                                        const factura = (f.ptoVta ? f.ptoVta + '-' : '') + (f.cbteNro || '');
                                        return '<tr>' +
                                            '<td style="padding:8px 10px; border-bottom:1px solid #eee;">' + fmtFechaPago(f.createdAt) + '</td>' +
                                            '<td style="padding:8px 10px; border-bottom:1px solid #eee;">' + tipo + '</td>' +
                                            '<td style="padding:8px 10px; border-bottom:1px solid #eee;">' + fmtPeriodo(f.periodoDesde) + ' ${icon('arrowRight', 'w-4 h-4 inline')} ' + fmtPeriodo(f.periodoHasta) + '</td>' +
                                            '<td style="padding:8px 10px; border-bottom:1px solid #eee; text-align:right; font-weight:600;">' + fmtMoney(f.monto) + '</td>' +
                                            '<td style="padding:8px 10px; border-bottom:1px solid #eee;">' + (factura || '—') + '</td>' +
                                            '</tr>';
                                    }).join('');
                                })
                                .catch(function(err) {
                                    console.error('Error cargando mis pagos:', err);
                                    info.innerHTML = '<p style="color:#b91c1c; font-size:14px;">No se pudieron cargar tus pagos. Intentalo nuevamente.</p>';
                                    tbody.innerHTML = '<tr><td colspan="5" style="padding:20px; text-align:center; color:#888;">Sin datos</td></tr>';
                                });
                        }

                        // --- Wizard State ---
                        let wizardState = {
                            parentId: 'root',
                            parentTitle: 'Raíz',
                            items: [],
                            currentItemIdx: 0,
                            step: 0, // 0=titulo, 1=precio, 2=cantidad, 3=another, 4=catName, 5=irAPagar, 6=pedirArchivo, 7=respuestaFAQ
                            prefix: 'menu',
                            nextTrigger: 1,
                            categoryName: '',
                            addPagar: false,
                            addArchivo: false,
                            isTurno: false,
                            isFaq: false
                        };

                        function openAddModal(idx) {
                            const parent = menuData[idx] || { title: 'Raíz', id: 'root' };
                            const parentId = parent.id || 'root';
                            currentParent = parent;

                            // Setup full form
                            document.getElementById('addParentId').value = parentId;
                            const childrenCount = menuData.filter(n => n.parentId === parentId).length;
                            const nextNumber = childrenCount + 1;
                            const prefix = parentId === 'root' ? 'menu' : parentId;
                            const newId = prefix + '_opcion' + nextNumber;
                            document.getElementById('addId').value = newId;
                            document.getElementById('addTrigger').value = nextNumber;
                            document.getElementById('addPrice').value = '';
                            document.getElementById('addRedirigirA').value = '';
                            document.getElementById('addNoDisponible').checked = false;
                            document.getElementById('addIsData').checked = false;
                            document.getElementById('addIsArchivo').checked = false;
                            document.getElementById('addIsPagar').checked = false;
                            updatePreview('add');

                            // Reset wizard state
                            wizardState = {
                                parentId: parentId,
                                parentTitle: parent.title || 'Raíz',
                                items: [],
                                currentItemIdx: 0,
                                step: 0,
                                prefix: prefix,
                                nextTrigger: nextNumber,
                                categoryName: '',
                                addPagar: false,
                                addArchivo: false,
                                isTurno: false,
                                isFaq: false
                            };

                            // Show initial question
                            document.getElementById('addModalTitle').textContent = 'Agregar Nuevo Hijo';
                            document.getElementById('wizardAsk').style.display = 'block';
                            document.getElementById('addFullForm').style.display = 'none';
                            document.getElementById('wizardContainer').style.display = 'none';
                            document.getElementById('addModal').style.display = "block";
                        }

                        function showFullForm() {
                            document.getElementById('addModalTitle').textContent = 'Agregar Nuevo Hijo (Formulario Completo)';
                            document.getElementById('wizardAsk').style.display = 'none';
                            document.getElementById('addFullForm').style.display = 'block';
                            document.getElementById('wizardContainer').style.display = 'none';
                            updatePreview('add');
                        }

                        function startItemWizard() {
                            const botTypeEl = document.getElementById('botTypeInput');
                            const typeVal = botTypeEl ? botTypeEl.value : 'CARRITO';
                            wizardState.isTurno = typeVal === 'TURNOS';
                            wizardState.isFaq = typeVal === 'FAQ';
                            if (wizardState.isTurno) {
                                document.getElementById('addModalTitle').textContent = 'Crear Servicios / Turnos';
                            } else if (wizardState.isFaq) {
                                document.getElementById('addModalTitle').textContent = 'Crear Preguntas / Respuestas (FAQ)';
                            } else {
                                document.getElementById('addModalTitle').textContent = 'Crear Items de Compra';
                            }
                            document.getElementById('wizardAsk').style.display = 'none';
                            document.getElementById('addFullForm').style.display = 'none';
                            document.getElementById('wizardContainer').style.display = 'block';

                            wizardState.items = [];
                            wizardState.currentItemIdx = 0;
                            wizardState.step = 0;
                            showWizardQuestion();
                        }

                        function showWizardQuestion() {
                            const container = document.getElementById('wizQuestionContent');
                            const stepIndicator = document.getElementById('wizStepIndicator');
                            const itemsCount = document.getElementById('wizItemsCount');
                            
                            if (wizardState.step >= 4) {
                                stepIndicator.textContent = 'Finalizar configuraci\u00f3n';
                            } else {
                                stepIndicator.textContent = (wizardState.isFaq ? 'Pregunta #' : (wizardState.isTurno ? 'Turno/Servicio #' : 'Item #')) + (wizardState.currentItemIdx + 1);
                            }
                            itemsCount.textContent = wizardState.items.length + (wizardState.isFaq ? ' preguntas agregadas' : (wizardState.isTurno ? ' turnos/servicios agregados' : ' items agregados'));

                            const qIdx = wizardState.currentItemIdx;

                            if (wizardState.step === 0) {
                                // Ask for title
                                const titleLabel = wizardState.isFaq ? '\u00bfPregunta?' : (wizardState.isTurno ? '\u00bfNombre del turno/servicio?' : '\u00bfT\u00edtulo del item?');
                                const titleHint = wizardState.isFaq
                                    ? 'ej: \u00bfHacen env\u00edos?, \u00bfCu\u00e1les son los horarios?, etc.'
                                    : (wizardState.isTurno
                                        ? 'ej: Pediatria, Cardiologia, Consulta general, etc.'
                                        : 'ej: Pizza Pepperoni, Coca Cola, etc.');
                                const titlePlaceholder = wizardState.isFaq ? 'ej: \u00bfHacen env\u00edos?' : (wizardState.isTurno ? 'ej: Pediatria' : 'ej: Pepperoni');
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\${titleLabel}</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">\${titleHint}</p>
                                    <input type="text" id="wizTitleInput" placeholder="\${titlePlaceholder}" style="width: 100%; padding: 12px; border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; box-sizing: border-box;" onkeydown="if(event.key==='Enter') wizNextTitle()" autofocus>
                                    <div style="margin-top: 15px; display: flex; gap: 10px;">
                                        <button type="button" onclick="wizNextTitle()" style="flex: 1; padding: 12px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">Siguiente \u2192</button>
                                    </div>
                                \`;
                                setTimeout(() => document.getElementById('wizTitleInput').focus(), 100);
                            } else if (wizardState.step === 1) {
                                // Ask for price
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfPrecio? (opcional)</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">Si tiene precio, escribilo. Si no, dejalo vac\u00edo.</p>
                                    <input type="text" id="wizPriceInput" placeholder="ej: 8000 (o vac\u00edo)" style="width: 100%; padding: 12px; border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; box-sizing: border-box;" onkeydown="if(event.key==='Enter') wizNextPrice()" autofocus>
                                    <div style="margin-top: 15px; display: flex; gap: 10px;">
                                        <button type="button" onclick="wizBack()" style="flex: 1; padding: 12px; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">\u2190 Atr\u00e1s</button>
                                        <button type="button" onclick="wizNextPrice()" style="flex: 1; padding: 12px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">Siguiente \u2192</button>
                                    </div>
                                \`;
                                setTimeout(() => document.getElementById('wizPriceInput').focus(), 100);
                            } else if (wizardState.step === 2) {
                                // Ask if quantity
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfPedir cantidad al usuario? (Si es un pedido)</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">Si marc\u00e1s "S\u00ed", el bot preguntar\u00e1 "\u00bfCu\u00e1ntas unidades?"</p>
                                    <div style="display: flex; gap: 15px;">
                                        <button type="button" onclick="wizSetQty(true)" style="flex: 1; padding: 15px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">S\u00ed, pedir cantidad</button>
                                        <button type="button" onclick="wizSetQty(false)" style="flex: 1; padding: 15px; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">No</button>
                                    </div>
                                \`;
                            } else if (wizardState.step === 3) {
                                // Ask to add another
                                const currentItem = wizardState.items[wizardState.items.length - 1];
                                const itemSummary = currentItem ? 
                                    '<span style="color: var(--primary-color); font-weight: 600;">\u2713 ' + currentItem.title + '</span>' : '';
                                const addedLabel = wizardState.isFaq ? '\u00a1Respuesta guardada!' : (wizardState.isTurno ? '\u00a1Turno/Servicio agregado!' : '\u00a1Item agregado!');
                                const anotherLabel = wizardState.isFaq ? '\u00bfAgregar otra pregunta?' : (wizardState.isTurno ? '\u00bfAgregar otro turno/servicio?' : '\u00bfAgregar otro item?');
                                const anotherYes = wizardState.isFaq ? 'S\u00ed, agregar otra' : (wizardState.isTurno ? 'S\u00ed, agregar otro' : 'S\u00ed, agregar otro');
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 5px; color: var(--text-main);">\${addedLabel}</p>
                                    <p style="font-size: 15px; margin-bottom: 15px;">\${itemSummary}</p>
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\${anotherLabel}</p>
                                    <div style="display: flex; gap: 15px;">
                                        <button type="button" onclick="wizAddAnother()" style="flex: 1; padding: 15px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">\${anotherYes}</button>
                                        <button type="button" onclick="wizGoFinalSteps()" style="flex: 1; padding: 15px; background: #6f42c1; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">No, finalizar</button>
                                    </div>
                                \`;
                            } else if (wizardState.step === 4) {
                                // Ask category name (only if parent is root)
                                if (wizardState.parentId === 'root') {
                                    const catHint = wizardState.isFaq
                                        ? 'Ej: Preguntas frecuentes, Consultas, etc.'
                                        : (wizardState.isTurno
                                            ? 'Ej: Reservar turno, Pediatria, Cardiologia, etc.'
                                            : 'Ej: Realizar un pedido, Hacer pedido, Comprar, etc.');
                                    const catPlaceholder = wizardState.isFaq ? 'ej: Preguntas frecuentes' : (wizardState.isTurno ? 'ej: Reservar turno' : 'ej: Realizar un pedido');
                                    container.innerHTML = \`
                                        <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfNombre de la categor\u00eda?</p>
                                        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">\${catHint}</p>
                                        <input type="text" id="wizCategoryInput" placeholder="\${catPlaceholder}" style="width: 100%; padding: 12px; border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; box-sizing: border-box;" onkeydown="if(event.key==='Enter') wizNextCatName()" autofocus>
                                        <div style="margin-top: 15px; display: flex; gap: 10px;">
                                            <button type="button" onclick="wizBack()" style="flex: 1; padding: 12px; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">\u2190 Atr\u00e1s</button>
                                            <button type="button" onclick="wizNextCatName()" style="flex: 1; padding: 12px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">Siguiente \u2192</button>
                                        </div>
                                    \`;
                                    setTimeout(() => document.getElementById('wizCategoryInput').focus(), 100);
                                } else {
                                    // Not root: skip category question, go straight to pedir archivo
                                    wizardState.step = 6;
                                    showWizardQuestion();
                                }
                            } else if (wizardState.step === 5) {
                                // Ask "Ir a pagar"
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfAgregar bot\u00f3n "Ir a pagar"?</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">Agrega un acceso directo a pagar desde el men\u00fa de la categor\u00eda.</p>
                                    <div style="display: flex; gap: 15px;">
                                        <button type="button" onclick="wizSetPagar(true)" style="flex: 1; padding: 15px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">S\u00ed, agregar</button>
                                        <button type="button" onclick="wizSetPagar(false)" style="flex: 1; padding: 15px; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">No</button>
                                    </div>
                                \`;
                            } else if (wizardState.step === 6) {
                                // Ask "Pedir archivo"
                                if (wizardState.isTurno || wizardState.isFaq) {
                                    wizFinish();
                                    return;
                                }
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfPedir comprobante/archivo al finalizar?</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">El bot\u00f3n "Finalizar" solicitar\u00e1 un archivo (ej: comprobante de pago).</p>
                                    <div style="display: flex; gap: 15px;">
                                        <button type="button" onclick="wizSetArchivo(true)" style="flex: 1; padding: 15px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">S\u00ed, pedir archivo</button>
                                        <button type="button" onclick="wizSetArchivo(false)" style="flex: 1; padding: 15px; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">No</button>
                                    </div>
                                \`;
                            } else if (wizardState.step === 7) {
                                // FAQ: ask for the answer
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfCu\u00e1l es la respuesta?</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">Texto que el bot enviar\u00e1 cuando el usuario elija esta pregunta.</p>
                                    <textarea id="wizAnswerInput" rows="4" placeholder="ej: S\u00ed, hacemos env\u00edos a todo el pa\u00eds..." style="width: 100%; padding: 12px; border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; box-sizing: border-box; resize: vertical;"></textarea>
                                    <div style="margin-top: 15px; display: flex; gap: 10px;">
                                        <button type="button" onclick="wizBack()" style="flex: 1; padding: 12px; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">\u2190 Atr\u00e1s</button>
                                        <button type="button" onclick="wizNextAnswer()" style="flex: 1; padding: 12px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">Siguiente \u2192</button>
                                    </div>
                                \`;
                                setTimeout(() => document.getElementById('wizAnswerInput').focus(), 100);
                            }

                            updateWizardPreview();
                        }

                        function wizNextTitle() {
                            const title = document.getElementById('wizTitleInput').value.trim();
                            if (!title) { alert('Por favor ingresá un título.'); return; }
                            wizardState.items[wizardState.currentItemIdx] = { title: title, price: '', askQty: false };
                            wizardState.step = wizardState.isTurno ? 3 : (wizardState.isFaq ? 7 : 1);
                            showWizardQuestion();
                        }

                        function wizNextAnswer() {
                            const answer = document.getElementById('wizAnswerInput').value.trim();
                            if (!answer) { alert('Por favor ingres\u00e1 la respuesta.'); return; }
                            if (wizardState.items[wizardState.currentItemIdx]) {
                                wizardState.items[wizardState.currentItemIdx].answer = answer;
                            }
                            wizardState.step = 3;
                            showWizardQuestion();
                        }

                        function wizNextPrice() {
                            const price = document.getElementById('wizPriceInput').value.trim();
                            if (wizardState.items[wizardState.currentItemIdx]) {
                                wizardState.items[wizardState.currentItemIdx].price = price;
                            }
                            wizardState.step = wizardState.isTurno ? 3 : 2;
                            showWizardQuestion();
                        }

                        function wizBack() {
                            if (wizardState.step === 6 && wizardState.parentId !== 'root') {
                                wizardState.step = 3;
                            } else if (wizardState.step === 7) {
                                wizardState.step = 0;
                            } else if (wizardState.step === 3 && wizardState.isFaq) {
                                wizardState.step = 7;
                            } else {
                                wizardState.step--;
                            }
                            showWizardQuestion();
                        }

                        function wizSetQty(askQty) {
                            if (wizardState.items[wizardState.currentItemIdx]) {
                                wizardState.items[wizardState.currentItemIdx].askQty = askQty;
                            }
                            wizardState.step = 3;
                            showWizardQuestion();
                        }

                        function wizAddAnother() {
                            wizardState.currentItemIdx++;
                            wizardState.step = 0;
                            showWizardQuestion();
                        }

                        function wizGoFinalSteps() {
                            wizardState.step = 4;
                            showWizardQuestion();
                        }

                        function wizNextCatName() {
                            const name = document.getElementById('wizCategoryInput').value.trim();
                            if (!name) { alert('Por favor ingres\u00e1 un nombre para la categor\u00eda.'); return; }
                            wizardState.categoryName = name;
                            wizardState.step = (wizardState.isTurno || wizardState.isFaq) ? 6 : 5;
                            showWizardQuestion();
                        }

                        function wizSetPagar(addPagar) {
                            wizardState.addPagar = addPagar;
                            wizardState.step = 6;
                            showWizardQuestion();
                        }

                        function wizSetArchivo(addArchivo) {
                            wizardState.addArchivo = addArchivo;
                            wizFinish();
                        }

                        async function wizFinish() {
                            const btnContainer = document.getElementById('wizQuestionContent');
                            btnContainer.innerHTML = '<p style="text-align: center; font-size: 16px; color: var(--text-muted);">Creando items... <span id="wizProgress"></span></p>';

                            const items = wizardState.items;
                            let parentId = wizardState.parentId;
                            const prefix = wizardState.prefix;
                            let trigger = wizardState.nextTrigger;

                            // If parent is root, create category node first
                            if (wizardState.parentId === 'root') {
                                const catId = prefix + '_opcion' + (trigger);
                                document.getElementById('wizProgress').textContent = 'Creando categor\u00eda...';
                                let catMessage = '';
                                if (wizardState.addPagar) {
                                    catMessage = '##PAGAR##';
                                }
                                try {
                                    await fetch('/app/api/add-node', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            botId: botId,
                                            id: catId,
                                            parentId: 'root',
                                            trigger: String(trigger),
                                            title: wizardState.categoryName,
                                            message: catMessage,
                                            price: '',
                                            redirigirA: '',
                                            disponible: 'true'
                                        })
                                    });
                                } catch (e) {
                                    console.error('Error creating category:', e);
                                }
                                parentId = catId;
                                trigger++;
                            }

                            for (let i = 0; i < items.length; i++) {
                                const item = items[i];
                                const nodeId = prefix + '_opcion' + (trigger);
                                document.getElementById('wizProgress').textContent = '(' + (i+1) + '/' + (items.length) + ')';

                                let message;
                                if (wizardState.isTurno) message = '##TURNO##';
                                else if (wizardState.isFaq) message = item.answer || '';
                                else message = item.askQty ? '##CANTIDAD##' : '##PEDIDO##';

                                try {
                                    await fetch('/app/api/add-node', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            botId: botId,
                                            id: nodeId,
                                            parentId: parentId,
                                            trigger: String(trigger),
                                            title: item.title,
                                            message: message,
                                            price: item.price,
                                            redirigirA: '',
                                            disponible: 'true'
                                        })
                                    });
                                } catch (e) {
                                    console.error('Error creating item:', e);
                                }
                                trigger++;
                            }

                            // Check if parent already has a FINALIZAR node (avoid duplicates)
                            // Solo aplica al flujo de carrito: TURNOS y FAQ no crean nodo Finalizar
                            const isCartFlow = !wizardState.isTurno && !wizardState.isFaq;
                            const existingFinal = isCartFlow ? menuData.find(function(n) {
                                return n.parentId === parentId && n.message && n.message.indexOf('##FINALIZAR##') !== -1;
                            }) : null;
                            if (isCartFlow && !existingFinal) {
                                document.getElementById('wizProgress').textContent = '(' + (items.length + 1) + '/' + (items.length + 1) + ') - Creando Finalizar...';
                                const finalId = prefix + '_opcion' + (trigger);
                                let finalMessage = '##FINALIZAR##';
                                if (wizardState.addArchivo) {
                                    finalMessage = 'Enviame captura de comprobante de pago por favor.\\n\\n##FINALIZAR##\\n\\n##ARCHIVO##';
                                }
                                try {
                                    await fetch('/app/api/add-node', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            botId: botId,
                                            id: finalId,
                                            parentId: parentId,
                                            trigger: String(trigger),
                                            title: '\u2705 Finalizar',
                                            message: finalMessage,
                                            price: '',
                                            redirigirA: '',
                                            disponible: 'true'
                                        })
                                    });
                                } catch (e) {
                                    console.error('Error creating finalizar node:', e);
                                }
                            }

                            // Redirect to refresh
                            window.location.href = '/app/?botId=' + encodeURIComponent(botId);
                        }

                        function updateWizardPreview() {
                            const chatBody = document.getElementById('wizChatBody');
                            let content = '';
                            
                            const parentTitle = wizardState.parentTitle || 'Menú';
                            content += '<div class="wa-bubble" style="font-weight: 600;">' + parentTitle + '</div>\\n';

                            const items = wizardState.items;
                            for (let i = 0; i < items.length; i++) {
                                const item = items[i];
                                const num = wizardState.nextTrigger + i;
                                let line = '*' + num + '*. ' + item.title;
                                if (item.price) line += ' ($' + item.price + ')';
                                content += '<div class="wa-bubble">' + line + '</div>\\n';
                                if (wizardState.isFaq && item.answer) {
                                    content += '<div class="wa-bubble" style="background: #f8f9fa;">' + item.answer + '</div>\\n';
                                }
                            }

                            // Show preview if there are items
                            if (items.length > 0) {
                                const nextNum = wizardState.nextTrigger + items.length;
                                if (wizardState.isTurno) {
                                    content += '<div class="wa-bubble" style="background: #f0fdf4; border: 1px dashed #86efac;">${icon('calendar', 'w-4 h-4 inline')} Reservar turno (' + nextNum + ')</div>\\n';
                                } else if (!wizardState.isFaq) {
                                    content += '<div class="wa-bubble" style="background: #f3f0ff; border: 1px dashed #d1d1ff;">${icon('checkCircle', 'w-4 h-4 inline text-green-400')} Finalizar (' + nextNum + ')</div>\\n';
                                }
                            }

                            chatBody.innerHTML = content;
                            chatBody.scrollTop = chatBody.scrollHeight;

                            // Update item list
                            const listContainer = document.getElementById('wizItemsList');
                            if (items.length === 0) {
                                listContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">No hay items todavía</p>';
                            } else {
                                let listHtml = '<div style="background: var(--bg-box); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px;">';
                                listHtml += '<div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px;">' + (wizardState.isFaq ? 'Preguntas agregadas:' : 'Items agregados:') + '</div>';
                                items.forEach((item, i) => {
                                    const num = wizardState.nextTrigger + i;
                                    const isCurrent = i === wizardState.currentItemIdx;
                                    const qtyBadge = item.askQty ? ' <span style="background: #eefbff; padding: 1px 6px; border-radius: 4px; font-size: 10px;">${icon('hashtag', 'w-4 h-4 inline')} cant.</span>' : '';
                                    listHtml += '<div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; ' + (isCurrent ? 'background: #f0fdf4; margin: 0 -8px; padding: 6px 8px; border-radius: 6px;' : '') + '">' +
                                        '<span style="background: ' + (isCurrent ? 'var(--primary-color)' : '#e9ecef') + '; color: ' + (isCurrent ? 'white' : '#666') + '; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">' + num + '</span>' +
                                        '<span style="flex: 1; font-size: 13px;">' + item.title + '</span>' +
                                        (item.price ? '<span style="font-size: 12px; color: var(--text-muted);">$' + item.price + '</span>' : '') +
                                        qtyBadge +
                                        '</div>';
                                });
                                if (!wizardState.isFaq) {
                                    listHtml += '<div style="border-top: 1px dashed var(--border-color); margin-top: 6px; padding-top: 6px; display: flex; align-items: center; gap: 8px;">' +
                                        '<span style="background: #e9ecef; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; color: #666;">' + (wizardState.nextTrigger + items.length) + '</span>' +
                                        '<span style="flex: 1; font-size: 13px; color: ' + (wizardState.isTurno ? '#166534' : '#6f42c1') + ';">' + (wizardState.isTurno ? '${icon('calendar', 'w-4 h-4 inline')} Reservar turno (auto)' : '${icon('checkCircle', 'w-4 h-4 inline text-green-400')} Finalizar (auto)') + '</span>' +
                                        '</div>';
                                }
                                listHtml += '</div>';
                                listContainer.innerHTML = listHtml;
                            }
                        }

                        function openEditModal(idx) {
                            const node = menuData[idx];
                            if (!node) return;

                            const isOrder = node.message && node.message.includes('##PEDIDO##');
                            const isQty = node.message && node.message.includes('##CANTIDAD##');
                            const isFinal = node.message && node.message.includes('##FINALIZAR##');
                            const isData = node.message && node.message.includes('##DATOS##');
                            const isArchivo = node.message && node.message.includes('##ARCHIVO##');
                            const isPagar = node.message && node.message.includes('##PAGAR##');

                            document.getElementById('editIndex').value = node.rowIndex;
                            document.getElementById('editId').value = node.id;
                            document.getElementById('editParentId').value = node.parentId;
                            document.getElementById('editTrigger').value = (node.id === 'root' && (node.trigger === '' || node.trigger === '0' || !node.trigger)) ? 'Hola' : node.trigger;
                            document.getElementById('editTitle').value = node.title;
                            document.getElementById('editMessage').value = stripTagsFromMessage(node.message || '');
                            document.getElementById('editPrice').value = node.price || '';
                            document.getElementById('editIsOrder').checked = isOrder;
                            document.getElementById('editIsQty').checked = isQty;
                            document.getElementById('editIsFinal').checked = isFinal;
                            document.getElementById('editIsData').checked = isData;
                            document.getElementById('editIsArchivo').checked = isArchivo;
                            document.getElementById('editIsPagar').checked = isPagar;
                            const editIsTurno = document.getElementById('editIsTurno');
                            if (editIsTurno) editIsTurno.checked = node.message && node.message.includes('##TURNO##');

                            const strictGroup = document.getElementById('strictTriggerGroup');
                            const strictCheckbox = document.getElementById('editStrictTrigger');
                            const titleInput = document.getElementById('editTitle');
                            const editTriggerGroup = document.getElementById('editTriggerGroup');
                            const editTitleGroup = document.getElementById('editTitleGroup');
                            const editTagsGroup = document.getElementById('editTagsGroup');

                            if (node.id === 'root') {
                                strictGroup.style.display = 'block';
                                strictCheckbox.checked = node.strictTrigger === 'true';
                                editTriggerGroup.style.display = 'flex'; 
                                editTitleGroup.style.display = 'none';
                                editTagsGroup.style.display = 'none';
                                titleInput.readOnly = true;
                                titleInput.style.background = '#eee';
                                const turnoModuleEditEl = document.getElementById('turnoModuleEdit');
                                if (turnoModuleEditEl) turnoModuleEditEl.style.display = 'none';
                            } else {
                                strictGroup.style.display = 'none';
                                strictCheckbox.checked = false;
                                editTriggerGroup.style.display = 'flex';
                                editTitleGroup.style.display = 'block';
                                editTagsGroup.style.display = 'flex';
                                titleInput.readOnly = false;
                                titleInput.style.background = 'var(--bg-box)';
                                toggleCartModules();
                            }

                            // Aplicamos el estado del título basado en si es DATOS después de la lógica de root
                            updateTitleState('edit', isData);

                            const parentInput = document.getElementById('editParentId');
                            if (node.id === 'root') {
                                parentInput.required = false;
                                parentInput.readOnly = true;
                                parentInput.style.background = '#eee';
                                parentInput.placeholder = '(Sin padre - Nodo Raíz)';
                            } else {
                                parentInput.required = true;
                                parentInput.readOnly = false;
                                parentInput.style.background = 'var(--bg-box)';
                                parentInput.placeholder = '';
                            }

                            document.getElementById('editRedirigirA').value = node.redirigirA || '';
                            document.getElementById('editNoDisponible').checked = node.disponible === 'false';
                            currentParent = menuData.find(n => n.id === node.parentId) || { title: 'Raíz', id: 'root' };
                            document.getElementById('editModal').style.display = "block";
                            updatePreview('edit');
                        }

                        function updatePreview(type) {
                            const id = document.getElementById(type + 'Id').value || '...';
                            const trigger = document.getElementById(type + 'Trigger').value || '?';
                            const title = document.getElementById(type + 'Title').value || 'Nuevo Título';
                            const message = document.getElementById(type + 'Message').value || '';
                            const price = document.getElementById(type + 'Price').value;
                            const parentId = type === 'edit' ? document.getElementById('editParentId').value : document.getElementById('addParentId').value;

                            const parent = menuData.find(n => n.id === parentId) || { title: 'Raíz', id: 'root' };
                            const grandparent = parent.parentId ? (menuData.find(n => n.id === parent.parentId) || (parent.parentId === 'root' ? { title: 'Raíz', id: 'root' } : null)) : null;

                            // Preparar lista de items para mostrar (incluyendo el actual)
                            let displayItems = menuData
                                .filter(n => n.parentId === parent.id && n.id !== (type === 'edit' ? document.getElementById('editId').value : '') && n.id !== 'root')
                                .map(n => ({ ...n, isCurrent: false }));
                            
                            if (id !== 'root') {
                                displayItems.push({
                                    id: id,
                                    trigger: trigger,
                                    title: title,
                                    price: price,
                                    isCurrent: true
                                });
                            }

                            // Ordenar por trigger (numérico si es posible)
                            displayItems.sort((a, b) => {
                                const ta = parseFloat(a.trigger) || 0;
                                const tb = parseFloat(b.trigger) || 0;
                                if (ta !== tb) return ta - tb;
                                return String(a.trigger).localeCompare(String(b.trigger));
                            });

                            let itemsHtml = '';
                            const indent = grandparent ? '      ' : '  ';
                            
                            displayItems.forEach((item, index) => {
                                const isLast = index === displayItems.length - 1;
                                const connector = isLast ? '└── ' : '├── ';
                                let itemLine = \`[ \${item.trigger}. \${item.title}\${item.price ? ' ($' + item.price + ')' : ''} ]\`;
                                
                                if (item.isCurrent) {
                                    itemLine = \`<span style="color: var(--primary-color); font-weight: bold;">\${itemLine}</span>\`;
                                }
                                
                                itemsHtml += \`\${indent}\${connector}\${itemLine}\\n\`;
                            });

                            let headerText = '';
                            if (grandparent) {
                                headerText = \`[ \${grandparent.title} ]\\n  └── \`;
                            }

                            const preview = document.getElementById(type + 'Preview');
                            preview.innerHTML = \`\${headerText}[ \${parent.title} ]\\n\${itemsHtml}\`;

                            // --- Tooltip Dynamic Update ---
                            const tooltip = document.getElementById(type + 'MessageTooltip');
                            if (tooltip) {
                                const triggerVal = trigger || '?';
                                let triggerText = \`"\${triggerVal}"\`;
                                
                                if (id === 'root') {
                                    const isStrict = document.getElementById('editStrictTrigger').checked;
                                    if (isStrict) {
                                        triggerText = \`exactamente "\${triggerVal}"\`;
                                    } else {
                                        triggerText = \`cualquier palabra (o "\${triggerVal}")\`;
                                    }
                                }
                                
                                tooltip.innerText = \`Esta será la respuesta cuando el usuario escriba \${triggerText}. Si deseas agregar un submenú aquí, agrega al mensaje 'Elige una opción:' y luego cierra esta ventana y agrega un "hijo" a esta respuesta.\`;
                            }

                            // --- WhatsApp Chat Preview ---
                            const chatBody = document.getElementById(type + 'ChatBody');
                            
                            // 1. Mensaje del Padre (Contexto)
                            let parentHtml = '';
                            if (parent && id !== 'root') {
                            let parentContent = (parent.message || '')
                                .replace('##PEDIDO##', '')
                                .replace('##CANTIDAD##', '')
                                .replace('##FINALIZAR##', '')
                                .replace('##DATOS##', '')
                                .replace('##ARCHIVO##', '')
                                .replace('##COMPLETAR##', '')
                                .replace('##PAGAR##', '')
                                .replace('##TURNO##', '')
                                .replace('_Este es el nodo de inicio, su mensaje no se muestra directamente en el bot._', '')
                                .trim();

                                // Usar los mismos displayItems ordenados para la lista de opciones
                                let optionsList = '';
                                displayItems.forEach(item => {
                                    const itemPrice = item.isCurrent ? price : item.price;
                                    const priceText = itemPrice ? ' ($' + itemPrice + ')' : '';
                                    if (item.isCurrent) {
                                        optionsList += \`*\${trigger}*. \${title}\${priceText}\\n\`;
                                    } else {
                                        optionsList += \`*\${item.trigger}*. \${item.title}\${priceText}\\n\`;
                                    }
                                });

                                if (optionsList) {
                                    parentContent += (parentContent ? '\\n\\n' : '') + optionsList;
                                }

                                if (parentContent) {
                                    parentHtml = \`<div class="wa-bubble">\${parentContent.replace(/\\n/g, '<br>')}</div>\`;
                                }
                            }

                            // 2. Acción del Usuario (El trigger)
                            const userHtml = \`<div class="wa-bubble-user">\${trigger}</div>\`;

                            // 3. Respuesta Actual (Lo que se está editando)
                            const hasDataTag = message.includes('##DATOS##') || message.includes('##ARCHIVO##');
                            let chatContent = (message || '_Sin mensaje configurado_')
                                .replace('##PEDIDO##', '')
                                .replace('##CANTIDAD##', '')
                                .replace('##FINALIZAR##', '')
                                .replace('##DATOS##', '')
                                .replace('##ARCHIVO##', '')
                                .replace('##COMPLETAR##', '')
                                .replace('##PAGAR##', '')
                                .replace('##TURNO##', '')
                                .replace('_Este es el nodo de inicio, su mensaje no se muestra directamente en el bot._', '')
                                .trim();
                            
                            const subOptions = menuData.filter(n => n.parentId === id);
                            if (subOptions.length > 0 && !hasDataTag) {
                                chatContent += '\\n\\n';
                                subOptions.forEach(opt => {
                                    const optPrice = opt.price ? ' ($' + opt.price + ')' : '';
                                    chatContent += \`*\${opt.trigger}*. \${opt.title}\${optPrice}\\n\`;
                                });
                                if (id !== 'root') {
                                    chatContent += \`\\n---\\n*v*. Volver atrás\\n*0*. Menú Principal\`;
                                }
                            }
                            const botHtml = \`<div class="wa-bubble">\${chatContent.replace(/\\n/g, '<br>')}</div>\`;

                            chatBody.innerHTML = parentHtml + userHtml + botHtml;
                            chatBody.scrollTop = chatBody.scrollHeight;
                        }

                        function confirmDelete(idx) {
                            const node = menuData[idx];
                            if (!node) return;
                            const nodeId = node.id;
                            const index = node.rowIndex;

                            const hasChildren = menuData.some(n => n.parentId === nodeId);
                            const title = document.getElementById('deleteConfirmTitle');
                            const message = document.getElementById('deleteConfirmMessage');
                            const confirmBtn = document.getElementById('deleteConfirmBtn');

                            if (hasChildren) {
                                title.innerText = '¿Eliminar opción y sub-menús?';
                                message.innerText = 'Esta opción tiene sub-menús. Si la borras, también se borrarán todos sus hijos. ¿Deseas continuar?';
                            } else {
                                title.innerText = '¿Eliminar esta opción?';
                                message.innerText = '¿Estás seguro de que deseas borrar esta fila?';
                            }

                            confirmBtn.onclick = function() {
                                window.location.href = '/app/delete/' + index + '?botId=' + encodeURIComponent(botId) + '&nodeId=' + encodeURIComponent(nodeId);
                            };

                            document.getElementById('deleteConfirmModal').style.display = "block";
                        }

                        function openCalendarHelp() {
                            document.getElementById('calendarHelpModal').style.display = "block";
                        }

                        function toggleCalendarSection() {
                            const body = document.getElementById('calendarBody');
                            const arrow = document.getElementById('calendarToggleArrow');
                            if (!body) return;
                            const hidden = body.style.display === 'none';
                            body.style.display = hidden ? '' : 'none';
                            if (arrow) arrow.style.transform = hidden ? '' : 'rotate(-90deg)';
                        }

                        function toggleStep(stepId, headerEl) {
                            const body = document.getElementById(stepId);
                            if (!body) return;
                            const hidden = body.style.display === 'none';
                            body.style.display = hidden ? '' : 'none';
                            const arrow = headerEl ? headerEl.querySelector('.step-toggle-arrow') : null;
                            if (arrow) arrow.style.transform = hidden ? '' : 'rotate(-90deg)';
                        }

                        function toggleColMenu() {
                            const menu = document.getElementById('colToggleMenu');
                            if (menu) menu.classList.toggle('open');
                        }

                        function toggleCol(col, show) {
                            document.querySelectorAll('.col-' + col).forEach(el => {
                                el.style.display = show ? '' : 'none';
                            });
                        }

                        document.addEventListener('click', function (e) {
                            const menu = document.getElementById('colToggleMenu');
                            if (menu && menu.classList.contains('open') && !e.target.closest('.col-toggle-wrap')) {
                                menu.classList.remove('open');
                            }
                        });

                        function closeModal(modalId) {
                            const el = document.getElementById(modalId);
                            if (el) el.style.display = "none";
                        }

                        // Cerrar modal al hacer click fuera del contenido
                        document.addEventListener('click', function(e) {
                            document.querySelectorAll('.modal').forEach(function(m) {
                                if (m.style.display === 'block' && e.target === m) {
                                    m.style.display = 'none';
                                }
                            });
                        });

                        // Cerrar modal al presionar Escape
                        document.addEventListener('keydown', function(e) {
                            if (e.key === 'Escape') {
                                document.querySelectorAll('.modal').forEach(function(m) {
                                    if (m.style.display === 'block') {
                                        m.style.display = 'none';
                                    }
                                });
                            }
                        });

                        // --- Support Bot ---
                        function toggleSupport() {
                            const modal = document.getElementById('supportModal');
                            const toggle = document.getElementById('supportToggle');
                            if (toggle.classList.contains('minimized')) {
                                toggle.classList.remove('minimized');
                                return;
                            }
                            modal.classList.toggle('open');
                            toggle.classList.toggle('open');
                            if (modal.classList.contains('open')) {
                                setTimeout(() => document.getElementById('supportInput').focus(), 300);
                            }
                        }

                        function minimizeSupport() {
                            const modal = document.getElementById('supportModal');
                            const toggle = document.getElementById('supportToggle');
                            modal.classList.remove('open');
                            toggle.classList.remove('open');
                            toggle.classList.add('minimized');
                        }

                        function sendSuggestion(el) {
                            document.getElementById('supportInput').value = el.textContent;
                            sendSupportMessage();
                        }

                        function getCurrentRowContext() {
                            const editModal = document.getElementById('editModal');
                            if (!editModal || editModal.style.display === 'none') return '';

                            const id = document.getElementById('editId').value;
                            const trigger = document.getElementById('editTrigger').value;
                            const title = document.getElementById('editTitle').value;
                            const price = document.getElementById('editPrice').value;
                            const message = document.getElementById('editMessage').value;
                            const isOrder = document.getElementById('editIsOrder').checked;
                            const isQty = document.getElementById('editIsQty').checked;
                            const isFinal = document.getElementById('editIsFinal').checked;
                            const isData = document.getElementById('editIsData').checked;
                            const isArchivo = document.getElementById('editIsArchivo').checked;
                            const isPagar = document.getElementById('editIsPagar').checked;

                            const tags = [];
                            if (isOrder) tags.push('##PEDIDO##');
                            if (isQty) tags.push('##CANTIDAD##');
                            if (isFinal) tags.push('##FINALIZAR##');
                            if (isData) tags.push('##DATOS##');
                            if (isArchivo) tags.push('##ARCHIVO##');
                            if (isPagar) tags.push('##PAGAR##');

                            const parentId = document.getElementById('editParentId').value;
                            const parent = menuData.find(n => n.id === parentId);
                            const parentStr = parent ? parent.title + ' (' + parent.id + ')' : 'Raiz';

                            const parts = [];
                            parts.push('--- NODO EN EDICION ---');
                            parts.push('ID: ' + id);
                            parts.push('Trigger: ' + trigger);
                            parts.push('Titulo: ' + title);
                            parts.push('Precio: ' + (price || 'sin precio'));
                            parts.push('Mensaje: ' + (message || '(vacio)'));
                            parts.push('Tags: ' + (tags.length ? tags.join(', ') : 'ninguno'));
                            parts.push('Padre: ' + parentStr);

                            return parts.join('\\n');
                        }

                        async function sendSupportMessage() {
                            const input = document.getElementById('supportInput');
                            const msg = input.value.trim();
                            if (!msg) return;

                            const context = getCurrentRowContext();

                            const body = document.getElementById('supportBody');
                            const sendBtn = document.getElementById('supportSendBtn');

                            body.innerHTML += '<div class="sb-bubble user">' + escapeHtml(msg) + (context ? '<div style="font-size:11px;opacity:0.6;margin-top:4px;">incluye contexto del nodo</div>' : '') + '</div>';
                            input.value = '';
                            sendBtn.disabled = true;

                            const typing = document.createElement('div');
                            typing.className = 'typing';
                            typing.innerHTML = '<span></span><span></span><span></span>';
                            typing.id = 'typingIndicator';
                            body.appendChild(typing);
                            body.scrollTop = body.scrollHeight;

                            try {
                                const res = await fetch('/app/api/support/ask', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ message: msg, context: context })
                                });
                                const data = await res.json();
                                document.getElementById('typingIndicator')?.remove();
                                body.innerHTML += '<div class="sb-bubble bot">' + data.response + '</div>';
                            } catch (err) {
                                document.getElementById('typingIndicator')?.remove();
                                body.innerHTML += '<div class="sb-bubble bot">Error de conexion. Verifica que el servidor este funcionando.</div>';
                            }

                            body.scrollTop = body.scrollHeight;
                            sendBtn.disabled = false;
                        }

                        function escapeHtml(text) {
                            const div = document.createElement('div');
                            div.textContent = text;
                            return div.innerHTML;
                        }

                        function toggleOrderTag(type, tag) {
                            const isOrderCheckbox = document.getElementById(type === 'edit' ? 'editIsOrder' : 'addIsOrder');
                            const isQtyCheckbox = document.getElementById(type === 'edit' ? 'editIsQty' : 'addIsQty');
                            const isFinalCheckbox = document.getElementById(type === 'edit' ? 'editIsFinal' : 'addIsFinal');
                            const isDataCheckbox = document.getElementById(type === 'edit' ? 'editIsData' : 'addIsData');
                            const isArchivoCheckbox = document.getElementById(type === 'edit' ? 'editIsArchivo' : 'addIsArchivo');
                            const isPagarCheckbox = document.getElementById(type === 'edit' ? 'editIsPagar' : 'addIsPagar');
                            const turnoCheckbox = document.getElementById(type === 'edit' ? 'editIsTurno' : 'addIsTurno');

                            // Los checkboxes son la fuente de verdad del tag; el textarea solo guarda texto limpio.
                            // Los tags activos se re-anexan al mensaje recién en applyTagsToMessage() (al enviar el form).
                            if (tag === '##PEDIDO##' && isOrderCheckbox.checked) {
                                isQtyCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                isArchivoCheckbox.checked = false;
                                if (turnoCheckbox) turnoCheckbox.checked = false;
                            } else if (tag === '##CANTIDAD##' && isQtyCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                isArchivoCheckbox.checked = false;
                                if (turnoCheckbox) turnoCheckbox.checked = false;
                            } else if (tag === '##DATOS##' && isDataCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isQtyCheckbox.checked = false;
                                isArchivoCheckbox.checked = false;
                                if (turnoCheckbox) turnoCheckbox.checked = false;
                            } else if (tag === '##ARCHIVO##' && isArchivoCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isQtyCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                if (turnoCheckbox) turnoCheckbox.checked = false;
                            } else if (tag === '##TURNO##' && turnoCheckbox && turnoCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isQtyCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                isArchivoCheckbox.checked = false;
                            }
                            updatePreview(type);
                        }

                        function stripTagsFromMessage(msg) {
                            let out = msg || '';
                            ['##PEDIDO##', '##CANTIDAD##', '##FINALIZAR##', '##DATOS##', '##ARCHIVO##', '##PAGAR##', '##TURNO##', '##MISTURNOS##'].forEach(function(t) {
                                while (out.indexOf(t) !== -1) { out = out.replace(t, ''); }
                            });
                            return out.trim();
                        }

                        // Re-anexa los tags activos (segun checkboxes) al mensaje limpio del textarea.
                        // Se ejecuta al enviar los forms de agregar/editar para que el tag se guarde
                        // sin que el usuario lo vea en el box de mensaje.
                        function applyTagsToMessage(type) {
                            const msgEl = document.getElementById(type + 'Message');
                            if (!msgEl) return;
                            const checks = [
                                [type + 'IsOrder', '##PEDIDO##'],
                                [type + 'IsQty', '##CANTIDAD##'],
                                [type + 'IsData', '##DATOS##'],
                                [type + 'IsTurno', '##TURNO##'],
                                [type + 'IsArchivo', '##ARCHIVO##'],
                                [type + 'IsFinal', '##FINALIZAR##'],
                                [type + 'IsPagar', '##PAGAR##']
                            ];
                            const clean = stripTagsFromMessage(msgEl.value);
                            const tags = [];
                            checks.forEach(function(pair) {
                                const cb = document.getElementById(pair[0]);
                                if (cb && cb.checked) tags.push(pair[1]);
                            });
                            const suffix = tags.join('\\n\\n');
                            msgEl.value = clean + (clean && suffix ? '\\n\\n' : '') + suffix;
                        }

                        (function () {
                            const hasContent = ${hasMenuContent};
                            const toolbar = document.querySelector('.toolbar');
                            if (toolbar) {
                                let ticking = false;
                                function onScroll() {
                                    if (ticking) return;
                                    ticking = true;
                                    requestAnimationFrame(function () {
                                        const rect = toolbar.getBoundingClientRect();
                                        const stuck = rect.top <= 0;
                                        toolbar.classList.toggle('is-stuck', stuck);
                                        if (stuck) toolbar.style.borderRadius = '0';
                                        else toolbar.style.borderRadius = '12px';
                                        ticking = false;
                                    });
                                }
                                window.addEventListener('scroll', onScroll, { passive: true });
                                onScroll();
                            }
                            if (!hasContent) return;
                            const target = document.getElementById('step3Section');
                            if (!target) return;
                            window.addEventListener('load', function () {
                                window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 10, behavior: 'smooth' });
                            });
                        })();
                    </script>
                </body>
                </html>
            `);
            } catch (error) {
                console.error('Error en vista principal:', error);
                res.status(500).send('Error al cargar el dashboard.');
            }
        });

        // Ruta para Borrar
        router.get('/delete/:index', async (req, res) => {
            try {
                const {
                    service,
                    botId
                } = await getServiceInfo(req);
                const index = req.params.index;
                const nodeId = req.query.nodeId;
                
                if (nodeId) {
                    await service.deleteNodeAndChildren(nodeId);
                } else {
                    await service.deleteRow(index);
                }
                res.redirect(`/app/?botId=${encodeURIComponent(botId)}`);
            } catch (error) {
                console.error('Error al borrar en Sheets:', error);
                res.status(500).send('Error al borrar la fila.');
            }
        });

        // Ruta para Guardar
        router.post('/save', async (req, res) => {
            try {
                const {
                    service,
                    botId
                } = await getServiceInfo(req);
                const {
                    index,
                    id,
                    parentId,
                    trigger,
                    title,
                    message,
                    price,
                    strictTrigger,
                    redirigirA,
                    disponible
                } = req.body;

                await service.updateNode(index, {
                    id,
                    parentId,
                    title,
                    message,
                    trigger,
                    price,
                    strictTrigger,
                    redirigirA,
                    disponible: disponible || 'true'
                });
                res.redirect(`/app/?botId=${encodeURIComponent(botId)}`);
            } catch (error) {
                console.error('Error al guardar en Sheets:', error);
                res.status(500).send('Error al guardar los datos.');
            }
        });

        // Ruta JSON API para agregar nodo (usado por el wizard)
        router.post('/api/add-node', async (req, res) => {
            try {
                const { service } = await getServiceInfo(req);
                const { id, parentId, trigger, title, message, price, redirigirA, disponible } = req.body;

                await service.addNode({
                    id,
                    parentId,
                    trigger,
                    title,
                    message,
                    price,
                    redirigirA,
                    disponible: disponible || 'true'
                });

                res.json({ success: true });
            } catch (error) {
                console.error('Error al agregar nodo via API:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Ruta para Agregar
        router.post('/add', async (req, res) => {
            try {
                const {
                    service,
                    botId
                } = await getServiceInfo(req);
                const {
                    id,
                    parentId,
                    trigger,
                    title,
                    message,
                    price,
                    redirigirA,
                    disponible
                } = req.body;

                await service.addNode({
                    id,
                    parentId,
                    trigger,
                    title,
                    message,
                    price,
                    redirigirA,
                    disponible: disponible || 'true'
                });

                res.redirect(`/app/?botId=${encodeURIComponent(botId)}`);
            } catch (error) {
                console.error('Error al agregar a Sheets:', error);
                res.status(500).send('Error al agregar los datos.');
            }
        });

        // POST /api/support/ask — Bot de soporte interno del editor
        router.post('/api/support/ask', async (req, res) => {
            try {
                const { message, context } = req.body;

                if (!message || typeof message !== 'string' || message.trim().length === 0) {
                    return res.status(400).json({ response: 'Escribí una pregunta válida.' });
                }

                let fullMessage = message.trim();
                if (context && typeof context === 'string' && context.trim()) {
                    fullMessage = '[CONTEXTO - Nodo en edicion]:\n' + context.trim() + '\n\n[CONSULTA]:\n' + fullMessage;
                }

                const response = await askGemini(fullMessage);
                res.json({ response });
            } catch (error) {
                console.error('[SupportBot] Error en endpoint:', error.message);
                res.status(500).json({ response: 'Error interno del servidor. Intentá de nuevo.' });
            }
        });

        return router;
    }
}

module.exports = new Dashboard();
