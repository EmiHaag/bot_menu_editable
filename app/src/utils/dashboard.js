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
const { helpGuideCSS, helpGuideHTML, helpGuideJS } = require('./helpGuide');
const { askGemini } = require('./geminiHelper');

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
                        <td><small>${client.spreadsheetId}</small></td>
                        <td>
                            <button onclick="deleteClient('${client.idCliente}')" class="btn-action btn-red">Borrar</button>
                            <a href="/app/?botId=${client.idCliente}" class="btn-action">Ver Menú</a>
                            <a href="/app/pedidos/${client.idCliente}" target="_blank" class="btn-action btn-green" style="background: #00bc7d; color: white;">Pedidos</a>
                        </td>
                    </tr>
                `).join('');

                res.send(`
                    <html>
                    <head>
                        <title>Panel de Administración - Bots</title>
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
                            .header { display: flex; flex-wrap: wrap;  margin-right: -15px;  margin-left: -15px; }
                            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                            th, td { padding: 12px; border: 1px solid var(--border-color); text-align: left; }
                            th { background: var(--bg-box); }
                            .btn { padding: 10px 20px; text-decoration: none; border-radius: 6px; cursor: pointer; font-weight: bold; }
                            .btn-green { background: var(--primary-color); color: white; border: none; }
                            .btn-red { background: var(--error-color); color: white; border: none; }
                            .btn-action { padding: 5px 10px; border-radius: 4px; text-decoration: none; border: 1px solid #ccc; font-size: 12px; color: #333; }
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
                        <script src="/js/robot-logo.js"></script>
                    </head>
                    <body>
                        <div class="header">
                            <div style="display: flex; align-items: center; gap: 15px; flex-wrap: wrap;">
                                <canvas id="botLogoAdmin" width="200" height="200" style="width: 50px; height: 50px;"></canvas>
                                <h2>Administración de Clientes</h2>
                            </div>
                            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                                <button onclick="document.getElementById('addClientModal').style.display='block'" class="btn btn-green">+ Nuevo Cliente</button>
                                <a href="/app/" class="btn" style="border: 1px solid #ccc">Volver al Editor</a>
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
                            <h3>⚙️ Configuración General</h3>
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

                        <script>
                            drawRobot('botLogoAdmin');
                            fetch('/api/config').then(function(r){return r.json()}).then(function(d){
                                document.getElementById('precioInput').value = d.precioEstandar;
                            });
                            function savePrice() {
                                var val = document.getElementById('precioInput').value;
                                if (!val) return;
                                fetch('/api/config', {
                                    method: 'POST',
                                    headers: {'Content-Type': 'application/json'},
                                    body: JSON.stringify({precio_estandar: Number(val)})
                                }).then(function(r){return r.json()}).then(function(){
                                    document.getElementById('priceStatus').textContent = '✅ Guardado';
                                    setTimeout(function(){document.getElementById('priceStatus').textContent = '';}, 3000);
                                });
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

                // 2. Si tenía un spreadsheet propio, mandarlo a la papelera
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

        // --- FIN RUTAS ADMINISTRACIÓN ---

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
                const activeClients = await userService.getActiveClients();

            let botSelector = '';
            if (isAdmin) {
                let botOptions = activeClients.map(client =>
                    `<option value="${client.idCliente}" ${client.idCliente === botId ? 'selected' : ''}>${client.nombreCliente} (${client.idCliente})</option>`
                ).join('');

                botSelector = `
                    <label>Bot:</label>
                    <select onchange="window.location.href='/app/?botId=' + this.value">
                        ${botOptions}
                    </select>
                `;
            } else {
                botSelector = `<span style="background: #e9ecef; padding: 5px 10px; border-radius: 5px; font-weight: bold; color: #495057;">Cliente: ${req.user.nombreCliente}</span>`;
            }

            let rowsHtml = menuData.map((node, idx) => {
                let displayTrigger = node.trigger;
                let displayTitle = node.title;

                if (node.id === 'root') {
                    displayTrigger = '<span style="color: #999;">-</span>';
                    displayTitle = '<span style="color: #999; font-style: italic;">(Configuración Inicial)</span>';
                }

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
                    .trim();

                return `
                <tr>
                    <td><b>${displayTrigger}</b></td>
                    <td>${displayTitle}</td>
                    <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${cleanMessage}</td>
                    <td>${node.price ? '$' + node.price : '-'}</td>
                    <td style="text-align: center;">${isOrder ? '<span style="color: var(--primary-color);">✅</span>' : '⚪'}</td>
                    <td style="text-align: center;">${isQty ? '<span style="color: var(--info-color);">🔢</span>' : '⚪'}</td>
                    <td style="text-align: center;">${isFinal ? '<span style="color: var(--secondary-color);">🏁</span>' : '⚪'}</td>
                    <td style="text-align: center;">${isData ? '<span style="color: var(--warning-color);">📝</span>' : '⚪'}</td>
                    <td style="text-align: center;">${isArchivo ? '<span style="color: var(--info-color);">📎</span>' : '⚪'}</td>
                    <td style="text-align: center;">${isPagar ? '<span style="color: var(--success-color);">💳</span>' : '⚪'}</td>
                    <td style="text-align: center; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${node.redirigirA || '<span style="color:#999;">-</span>'}</td>
                    <td style="text-align: center;">${node.disponible === 'false' ? '<span style="color:#999;" title="No disponible">🚫</span>' : '<span style="color:var(--primary-color);" title="Disponible">✅</span>'}</td>
                    <td>
                        <div style="display: flex; gap: 5px;">
                            <button type="button" onclick="openEditModal(${idx})" class="btn-action btn-orange">Editar</button>
                            <button type="button" onclick="openAddModal(${idx})" class="btn-action btn-blue">+ Hijo</button>
                            <button type="button" onclick="confirmDelete(${idx})" class="btn-action btn-red">Borrar</button>
                        </div>
                    </td>
                </tr>
                `;
            }).join('');
            res.send(`
                <html>
                <head>
                    <title>Editor de Menú de WhatsApp - ${botId}</title>
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
                            font-size: 13px;
                        }

                        th, td { 
                            padding: 8px 10px; 
                            border: 1px solid var(--border-color); 
                            text-align: left; 
                        }

                        th { 
                            background: var(--bg-box); 
                            color: var(--text-muted);
                            font-weight: 600;
                            text-transform: uppercase;
                            font-size: 11px;
                            letter-spacing: 0.3px;
                        }

                        .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
                        .toolbar select, .toolbar label { font-size: 14px; white-space: nowrap; }
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
                        }

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
                        }
                        .btn-action:hover { 
                            background: var(--primary-color); 
                            color: white; 
                            border-color: var(--primary-color);
                        }

                        /* Legacy color classes mapped to unified style */
                        .btn-green, .btn-blue, .btn-orange, .btn-purple { 
                            background: var(--bg-box); 
                            color: var(--text-muted);
                            border: 1px solid var(--border-color);
                        }
                        .btn-green:hover, .btn-blue:hover, .btn-orange:hover, .btn-purple:hover {
                            background: var(--primary-color);
                            color: white;
                            border-color: var(--primary-color);
                        }

                        /* Red button (Logout/Delete) always red */
                        .btn-red {
                            background: var(--error-color) !important;
                            color: white !important;
                            border: 1px solid var(--error-color) !important;
                        }
                        .btn-red:hover {
                            opacity: 0.9;
                            transform: translateY(-1px);
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
                            padding: 30px; 
                            width: 50%; 
                            max-height: calc(100vh - 80px);
                            overflow-y: auto;
                            border-radius: 12px; 
                            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
                            border: 1px solid var(--border-color);
                            position: relative;
                        }
                        .modal-content h2 { margin-top: 0; color: var(--text-main); margin-bottom: 25px; }
                        
                        .form-group { margin-bottom: 20px; }
                        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: var(--text-muted); font-size: 14px; }
                        .form-group input, .form-group textarea { 
                            width: 100%; 
                            padding: 12px; 
                            border: 1px solid var(--border-color); 
                            border-radius: 6px; 
                            box-sizing: border-box; 
                            font-size: 15px;
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
                        .modal-body-wrapper { display: flex; gap: 30px; align-items: flex-start; }
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
                            transition: transform 0.2s, box-shadow 0.2s;
                            user-select: none;
                        }
                        .support-toggle:hover { transform: scale(1.05); box-shadow: 0 6px 25px rgba(0,0,0,0.15); }
                        .support-toggle canvas { display: block; }
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
                            .toolbar { justify-content: center; }
                            .toolbar .btn, .toolbar select { width: 100%; min-width: unset; box-sizing: border-box; }
                            .toolbar select { font-size: 14px; }
                            .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -4px; }
                            .table-wrap table { min-width: 900px; }
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
                                <div class="status-box" id="statusBox"><span class="status-dot off" id="statusDot"></span> <span id="statusLabel">Verificando...</span></div>
                            </div>
                        </div>
                        <div class="toolbar">
                            ${botSelector}
                            ${isAdmin ? '<a href="/app/admin" class="btn btn-blue" style="background: #007bff; color: white;">Panel Admin</a>' : ''}
                            <button onclick="showVisual()" class="btn btn-purple">Visualizar</button>
                            <a href="/app/qr" class="btn btn-green">WhatsApp QR</a>
                            <a href="/app/refresh?botId=${botId}" class="btn btn-orange">Refrescar</a>
                            <a href="/app/pedidos/${botId}" target="_blank" class="btn btn-green">Ver Pedidos</a>
                            ${isAdmin ? `<a href="https://docs.google.com/spreadsheets/d/${service.spreadsheetId}" target="_blank" class="btn btn-blue">Abrir Sheet</a>` : ''}
                            <a href="/app/logout" class="btn btn-red">Salir</a>
                        </div>
                    </div>

${helpGuideHTML}

                    <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Disparador</th>
                                <th>Título</th>
                                <th>Mensaje (Resumen)</th>
                                <th>Precio</th>
                                <th>Pedido</th>
                                <th>Cant.</th>
                                <th>Fin</th>
                                <th>Datos</th>
                                <th>Archivo</th>
                                <th>Pagar</th>
                                <th>Redirigir</th>
                                <th>Disp.</th>
                                <th>Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
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
                                <p style="font-size: 18px; margin-bottom: 30px; color: var(--text-main);">¿Es un item de compra/pedido?</p>
                                <div style="display: flex; gap: 20px; justify-content: center;">
                                    <button type="button" onclick="startItemWizard()" style="padding: 15px 40px; font-size: 16px; font-weight: 600; background: var(--primary-color); color: white; border: none; border-radius: 8px; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">Sí, es un item</button>
                                    <button type="button" onclick="showFullForm()" style="padding: 15px 40px; font-size: 16px; font-weight: 600; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">No, formulario completo</button>
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

                                        <form action="/app/add" method="POST">
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
                                            <div class="form-group" style="margin-bottom: 20px;">
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
                                    <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 5px solid #ffc107;">
                                        <small style="color: #856404; display: block; margin-bottom: 10px;">Vista previa actual:</small>
                                        <div id="editPreview" style="font-family: monospace; white-space: pre-wrap; font-size: 13px; max-height: 120px; overflow-y: auto; overflow-x: hidden;"></div>
                                    </div>

                                    <form action="/app/save" method="POST">
                                        <input type="hidden" name="botId" value="${botId}">
                                        <input type="hidden" id="editIndex" name="index">
                                        <input type="hidden" id="editId" name="id">
                                        <input type="hidden" id="editParentId" name="parentId">
                                        
                                        <div class="form-group" id="strictTriggerGroup" style="display: none; background: #f0fdf4; padding: 15px; border-radius: 6px; border: 1px solid #bbf7d0; margin-bottom: 20px;">
                                            <div style="display: flex; align-items: center; gap: 12px;">
                                                <input type="checkbox" id="editStrictTrigger" name="strictTrigger" value="true" style="width: 22px; height: 22px; cursor: pointer;" onchange="updatePreview('edit')">
                                                <div>
                                                    <label for="editStrictTrigger" style="margin-bottom: 2px; cursor: pointer; color: #166534; font-size: 14px; font-weight: 700;">Activar bot solo con disparador exacto</label>
                                                    <p style="margin: 0; font-size: 12px; color: #15803d;">Si está marcado, el bot solo responderá si el usuario escribe exactamente el disparador inicial. Si no, responderá a cualquier palabra.</p>
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
                                        <div class="form-group" id="editTagsGroup" style="margin-bottom: 20px;">
                                            <div style="border:1px solid var(--border-color);border-radius:8px;padding:12px 12px 8px 12px;margin:12px;">
                                                <div style="font-size:12px;font-weight:700;color:var(--text-main);margin-bottom:8px;">Carrito de compras</div>
                                                <div class="tags-flex-row" style="display:flex;gap:10px;">
                                                    <div style="flex:1;display:flex;align-items:center;gap:10px;background:#fff3cd;padding:10px;border-radius:6px;border:1px dashed #ffc107;">
                                                    <input type="checkbox" id="editIsOrder" onchange="toggleOrderTag('edit', '##PEDIDO##')" style="width:16px;height:16px;cursor:pointer;">
                                                    <label for="editIsOrder" style="margin-bottom:0;cursor:pointer;color:#856404;font-size:13px;">¿Crear pedido?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Agrega "1 x Título" al carrito de compras.</span></span></label>
                                                </div>
                                                <div style="flex:1;display:flex;align-items:center;gap:10px;background:#eefbff;padding:10px;border-radius:6px;border:1px dashed #bee5eb;">
                                                    <input type="checkbox" id="editIsQty" onchange="toggleOrderTag('edit', '##CANTIDAD##')" style="width:16px;height:16px;cursor:pointer;">
                                                    <label for="editIsQty" style="margin-bottom:0;cursor:pointer;color:#0c5460;font-size:13px;">¿Pedir cantidad?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Pregunta al usuario cuántas unidades quiere llevar.</span></span></label>
                                                </div>
                                                <div style="flex:1;display:flex;align-items:center;gap:10px;background:#f3f0ff;padding:10px;border-radius:6px;border:1px dashed #d1d1ff;">
                                                    <input type="checkbox" id="editIsFinal" onchange="toggleOrderTag('edit', '##FINALIZAR##')" style="width:16px;height:16px;cursor:pointer;">
                                                    <label for="editIsFinal" style="margin-bottom:0;cursor:pointer;color:#5227cc;font-size:13px;">¿Finalizar?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Muestra el resumen y vacía el carrito. Combinable con otros tags.</span></span></label>
                                                    </div>
                                                </div>
                                                <div class="tags-flex-row" style="display:flex;gap:10px;margin-top:6px;">
                                                    <div style="flex:1;display:flex;align-items:center;gap:10px;background:#fff4e5;padding:10px;border-radius:6px;border:1px dashed #ff9800;">
                                                        <input type="checkbox" id="editIsData" onchange="toggleOrderTag('edit', '##DATOS##')" style="width:16px;height:16px;cursor:pointer;">
                                                        <label for="editIsData" style="margin-bottom:0;cursor:pointer;color:#856404;font-size:13px;">¿Capturar dato?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Espera que el usuario escriba texto libre (nombre, dirección, etc.).</span></span></label>
                                                    </div>
                                                    <div style="flex:1;display:flex;align-items:center;gap:10px;background:#e8f5e9;padding:10px;border-radius:6px;border:1px dashed #66bb6a;">
                                                        <input type="checkbox" id="editIsArchivo" onchange="toggleOrderTag('edit', '##ARCHIVO##')" style="width:16px;height:16px;cursor:pointer;">
                                                        <label for="editIsArchivo" style="margin-bottom:0;cursor:pointer;color:#2e7d32;font-size:13px;">¿Solicitar archivo?<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Espera que el usuario envíe una imagen o archivo.</span></span></label>
                                                    </div>
                                                </div>
                                                <div class="tags-flex-row" style="display:flex;gap:10px;margin-top:6px;">
                                                    <div style="flex:1;display:flex;align-items:center;gap:10px;background:#f0fdf4;padding:10px;border-radius:6px;border:1px dashed #86efac;">
                                                        <input type="checkbox" id="editIsPagar" onchange="toggleOrderTag('edit', '##PAGAR##')" style="width:16px;height:16px;cursor:pointer;">
                                                        <label for="editIsPagar" style="margin-bottom:0;cursor:pointer;color:#166534;font-size:13px;">Ir a pagar<span class="info-icon" style="margin-left:4px;">i<span class="tooltip">Muestra "p. Ir a pagar" cuando hay items en el carrito. Al escribir p va al primer hijo con Finalizar.</span></span></label>
                                                    </div>
                                                    <div style="flex:1;"></div>
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
                                        <div class="form-group" style="display:flex;align-items:center;gap:10px;background:#fff3e0;padding:12px;border-radius:6px;border:1px dashed #ffb74d;">
                                            <input type="checkbox" id="editNoDisponible" name="disponible" value="false" style="width:18px;height:18px;cursor:pointer;">
                                            <label for="editNoDisponible" style="margin-bottom:0;cursor:pointer;font-weight:700;color:#e65100;">No disponible (sin stock)</label>
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
                    <div class="support-toggle" id="supportToggle" onclick="toggleSupport()">
                        <canvas id="botLogoSupport" width="200" height="200" style="width: 40px; height: 40px;"></canvas>
                        <span class="label">te ayudo?</span>
                    </div>
                    <div class="support-modal" id="supportModal">
                        <div class="support-header">
                            <canvas id="botLogoSupportHeader" width="200" height="200" style="width: 36px; height: 36px;"></canvas>
                            <div>
                                <h4>Asistente del Editor</h4>
                                <div class="sub">Consultá cómo usar el editor</div>
                            </div>
                            <button onclick="toggleSupport()" style="background:none;border:none;color:white;font-size:20px;cursor:pointer;">&times;</button>
                        </div>
                        <div class="support-body" id="supportBody">
                            <div class="sb-bubble bot">¡Hola! Soy el asistente del editor de menú. Haceme cualquier pregunta sobre cómo crear o modificar el menú de tu bot de WhatsApp. 😊</div>
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
                                    <button id="supportSendBtn" onclick="sendSupportMessage()">➤</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <script>
                        const menuData = ${JSON.stringify(menuData)};
                        const botId = "${botId}";
                        let currentParent = null;

${helpGuideJS}
                        drawRobot('botLogoDash');
                        drawRobot('botLogoSupport');
                        drawRobot('botLogoSupportHeader');

                        function checkBotStatus() {
                            const dot = document.getElementById('statusDot');
                            const label = document.getElementById('statusLabel');
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
                                        error: 'Error'
                                    };
                                    const cls = data.status === 'connected' ? 'on' :
                                        data.status === 'error' || data.status === 'logged_out' || data.status === 'timeout_qr' ? 'error' : 'off';
                                    dot.className = 'status-dot ' + cls;
                                    label.textContent = labels[data.status] || data.status;
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
                            container.innerHTML = buildTree('root');
                            document.getElementById('visualModal').style.display = "block";
                        }

                        // --- Wizard State ---
                        let wizardState = {
                            parentId: 'root',
                            parentTitle: 'Raíz',
                            items: [],
                            currentItemIdx: 0,
                            step: 0, // 0=titulo, 1=precio, 2=cantidad, 3=another, 4=catName, 5=irAPagar, 6=pedirArchivo
                            prefix: 'menu',
                            nextTrigger: 1,
                            categoryName: '',
                            addPagar: false,
                            addArchivo: false
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
                                addArchivo: false
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
                            document.getElementById('addModalTitle').textContent = 'Crear Items de Compra';
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
                                stepIndicator.textContent = 'Item #' + (wizardState.currentItemIdx + 1);
                            }
                            itemsCount.textContent = wizardState.items.length + ' items agregados';

                            const qIdx = wizardState.currentItemIdx;

                            if (wizardState.step === 0) {
                                // Ask for title
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfT\u00edtulo del item?</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">ej: Pizza Pepperoni, Coca Cola, etc. o si son turnos: Pediatria, Cardiologia, etc.</p>
                                    <input type="text" id="wizTitleInput" placeholder="ej: Pepperoni" style="width: 100%; padding: 12px; border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; box-sizing: border-box;" onkeydown="if(event.key==='Enter') wizNextTitle()" autofocus>
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
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 5px; color: var(--text-main);">\u00a1Item agregado!</p>
                                    <p style="font-size: 15px; margin-bottom: 15px;">\${itemSummary}</p>
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfAgregar otro item?</p>
                                    <div style="display: flex; gap: 15px;">
                                        <button type="button" onclick="wizAddAnother()" style="flex: 1; padding: 15px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">S\u00ed, agregar otro</button>
                                        <button type="button" onclick="wizGoFinalSteps()" style="flex: 1; padding: 15px; background: #6f42c1; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">No, finalizar</button>
                                    </div>
                                \`;
                            } else if (wizardState.step === 4) {
                                // Ask category name (only if parent is root)
                                if (wizardState.parentId === 'root') {
                                    container.innerHTML = \`
                                        <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfNombre de la categor\u00eda?</p>
                                        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">Ej: Realizar un pedido, Hacer pedido, Comprar, etc.</p>
                                        <input type="text" id="wizCategoryInput" placeholder="ej: Realizar un pedido" style="width: 100%; padding: 12px; border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; box-sizing: border-box;" onkeydown="if(event.key==='Enter') wizNextCatName()" autofocus>
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
                                container.innerHTML = \`
                                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: var(--text-main);">\u00bfPedir comprobante/archivo al finalizar?</p>
                                    <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 15px;">El bot\u00f3n "Finalizar" solicitar\u00e1 un archivo (ej: comprobante de pago).</p>
                                    <div style="display: flex; gap: 15px;">
                                        <button type="button" onclick="wizSetArchivo(true)" style="flex: 1; padding: 15px; background: var(--primary-color); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">S\u00ed, pedir archivo</button>
                                        <button type="button" onclick="wizSetArchivo(false)" style="flex: 1; padding: 15px; background: var(--bg-box); color: var(--text-muted); border: 2px solid var(--border-color); border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;">No</button>
                                    </div>
                                \`;
                            }

                            updateWizardPreview();
                        }

                        function wizNextTitle() {
                            const title = document.getElementById('wizTitleInput').value.trim();
                            if (!title) { alert('Por favor ingresá un título.'); return; }
                            wizardState.items[wizardState.currentItemIdx] = { title: title, price: '', askQty: false };
                            wizardState.step = 1;
                            showWizardQuestion();
                        }

                        function wizNextPrice() {
                            const price = document.getElementById('wizPriceInput').value.trim();
                            if (wizardState.items[wizardState.currentItemIdx]) {
                                wizardState.items[wizardState.currentItemIdx].price = price;
                            }
                            wizardState.step = 2;
                            showWizardQuestion();
                        }

                        function wizBack() {
                            if (wizardState.step === 6 && wizardState.parentId !== 'root') {
                                wizardState.step = 3;
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
                            wizardState.step = 5;
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
                                document.getElementById('wizProgress').textContent = '(' + (i+1) + '/' + (items.length + 1) + ')';

                                let message = item.askQty ? '##CANTIDAD##' : '##PEDIDO##';

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
                            const existingFinal = menuData.find(function(n) {
                                return n.parentId === parentId && n.message && n.message.indexOf('##FINALIZAR##') !== -1;
                            });
                            if (!existingFinal) {
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
                            }

                            // Show preview if there are items
                            if (items.length > 0) {
                                const nextNum = wizardState.nextTrigger + items.length;
                                content += '<div class="wa-bubble" style="background: #f3f0ff; border: 1px dashed #d1d1ff;">✅ Finalizar (' + nextNum + ')</div>\\n';
                            }

                            chatBody.innerHTML = content;
                            chatBody.scrollTop = chatBody.scrollHeight;

                            // Update item list
                            const listContainer = document.getElementById('wizItemsList');
                            if (items.length === 0) {
                                listContainer.innerHTML = '<p style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">No hay items todavía</p>';
                            } else {
                                let listHtml = '<div style="background: var(--bg-box); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px;">';
                                listHtml += '<div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px;">Items agregados:</div>';
                                items.forEach((item, i) => {
                                    const num = wizardState.nextTrigger + i;
                                    const isCurrent = i === wizardState.currentItemIdx;
                                    const qtyBadge = item.askQty ? ' <span style="background: #eefbff; padding: 1px 6px; border-radius: 4px; font-size: 10px;">🔢 cant.</span>' : '';
                                    listHtml += '<div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; ' + (isCurrent ? 'background: #f0fdf4; margin: 0 -8px; padding: 6px 8px; border-radius: 6px;' : '') + '">' +
                                        '<span style="background: ' + (isCurrent ? 'var(--primary-color)' : '#e9ecef') + '; color: ' + (isCurrent ? 'white' : '#666') + '; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">' + num + '</span>' +
                                        '<span style="flex: 1; font-size: 13px;">' + item.title + '</span>' +
                                        (item.price ? '<span style="font-size: 12px; color: var(--text-muted);">$' + item.price + '</span>' : '') +
                                        qtyBadge +
                                        '</div>';
                                });
                                listHtml += '<div style="border-top: 1px dashed var(--border-color); margin-top: 6px; padding-top: 6px; display: flex; align-items: center; gap: 8px;">' +
                                    '<span style="background: #e9ecef; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; color: #666;">' + (wizardState.nextTrigger + items.length) + '</span>' +
                                    '<span style="flex: 1; font-size: 13px; color: #6f42c1;">✅ Finalizar (auto)</span>' +
                                    '</div>';
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
                            document.getElementById('editMessage').value = node.message || '';
                            document.getElementById('editPrice').value = node.price || '';
                            document.getElementById('editIsOrder').checked = isOrder;
                            document.getElementById('editIsQty').checked = isQty;
                            document.getElementById('editIsFinal').checked = isFinal;
                            document.getElementById('editIsData').checked = isData;
                            document.getElementById('editIsArchivo').checked = isArchivo;
                            document.getElementById('editIsPagar').checked = isPagar;

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
                            } else {
                                strictGroup.style.display = 'none';
                                strictCheckbox.checked = false;
                                editTriggerGroup.style.display = 'flex';
                                editTitleGroup.style.display = 'block';
                                editTagsGroup.style.display = 'flex';
                                titleInput.readOnly = false;
                                titleInput.style.background = 'var(--bg-box)';
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
                            modal.classList.toggle('open');
                            toggle.classList.toggle('open');
                            if (modal.classList.contains('open')) {
                                setTimeout(() => document.getElementById('supportInput').focus(), 300);
                            }
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
                            const messageEl = document.getElementById(type + 'Message');
                            const isOrderCheckbox = document.getElementById(type === 'edit' ? 'editIsOrder' : 'addIsOrder');
                            const isQtyCheckbox = document.getElementById(type === 'edit' ? 'editIsQty' : 'addIsQty');
                            const isFinalCheckbox = document.getElementById(type === 'edit' ? 'editIsFinal' : 'addIsFinal');
                            const isDataCheckbox = document.getElementById(type === 'edit' ? 'editIsData' : 'addIsData');
                            const isArchivoCheckbox = document.getElementById(type === 'edit' ? 'editIsArchivo' : 'addIsArchivo');
                            const isPagarCheckbox = document.getElementById(type === 'edit' ? 'editIsPagar' : 'addIsPagar');
                            
                            let currentVal = messageEl.value
                                .replace('##PEDIDO##', '')
                                .replace('##CANTIDAD##', '')
                                .replace('##FINALIZAR##', '')
                                .replace('##DATOS##', '')
                                .replace('##ARCHIVO##', '')
                                .replace('##PAGAR##', '')
                                .trim();
                            
                            if (tag === '##PAGAR##' || tag === '##FINALIZAR##') {
                                let val = messageEl.value
                                    .replace(tag, '')
                                    .trim();
                                const cb = tag === '##PAGAR##' ? isPagarCheckbox : isFinalCheckbox;
                                if (cb.checked) {
                                    messageEl.value = val + (val ? '\\n\\n' : '') + tag;
                                } else {
                                    messageEl.value = val;
                                }
                                updatePreview(type);
                                return;
                            }
                            
                            if (tag === '##PEDIDO##' && isOrderCheckbox.checked) {
                                isQtyCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                isArchivoCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##PEDIDO##';
                            } else if (tag === '##CANTIDAD##' && isQtyCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                isArchivoCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##CANTIDAD##';
                            } else if (tag === '##DATOS##' && isDataCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isQtyCheckbox.checked = false;
                                isArchivoCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##DATOS##';
                            } else if (tag === '##ARCHIVO##' && isArchivoCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isQtyCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##ARCHIVO##';
                            } else {
                                messageEl.value = currentVal;
                            }
                            
                            updatePreview(type);
                        }
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
