require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const GoogleSheetsService = require('../services/googleSheetsService');
const userService = require('../services/userService');
const {
    google
} = require('googleapis');

class Dashboard {
    constructor() {
        this.services = {};
    }

    async initService(botId) {
        if (!this.services[botId]) {
            this.services[botId] = new GoogleSheetsService({
                clientId: botId,
                spreadsheetId: process.env.SPREADSHEET_ID,
                credentials: process.env.CREDENTIALS_JSON
            });
        }
        return this.services[botId];
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
            } else if (!botId) {
                // Si es admin y no hay botId en query, buscar el primero disponible
                const activeClients = await userService.getActiveClients();
                botId = activeClients.length > 0 ? activeClients[0].idCliente : 'default';
            }

            const service = await this.initService(botId);
            return {
                service,
                botId,
                isAdmin: loggedUser.idCliente === 'admin'
            };
        };

        // Ruta para refrescar caché
        router.get('/refresh', async (req, res) => {
            const {
                service,
                botId
            } = await getServiceInfo(req);
            if (service) service.clearCache();
            res.redirect(`/?botId=${botId}`);
        });

        // Vista Principal
        router.get('/', async (req, res) => {
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
                    <select onchange="window.location.href='/?botId=' + this.value">
                        ${botOptions}
                    </select>
                `;
            } else {
                botSelector = `<span style="background: #e9ecef; padding: 5px 10px; border-radius: 5px; font-weight: bold; color: #495057;">Cliente: ${req.user.nombreCliente}</span>`;
            }

            let rowsHtml = menuData.map((node) => {
                let displayTrigger = node.trigger;
                if (node.id === 'root' && (displayTrigger === '0' || displayTrigger === '' || !displayTrigger)) {
                    displayTrigger = 'Hola';
                }

                return `
                <tr>
                    <td><b>${displayTrigger}</b></td>
                    <td>${node.title}</td>
                    <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${node.message}</td>
                    <td>
                        <div style="display: flex; gap: 5px;">
                            <button type="button" onclick="openEditModal('${node.rowIndex}', '${node.id}', '${node.parentId}', '${displayTrigger}', '${node.title}', \`${node.message.replace(/'/g, "").replace(/"/g, '').replace(/\n/g, "\\n")}\`)" class="btn-action btn-orange">Editar</button>
                            <button type="button" onclick="openAddModal('${node.id}')" class="btn-action btn-blue">+ Hijo</button>
                            <button type="button" onclick="confirmDelete('${node.rowIndex}')" class="btn-action btn-red">Borrar</button>
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
                            margin: 40px; 
                            background: var(--bg-white); 
                            color: var(--text-main);
                        }

                        .header { 
                            display: flex; 
                            justify-content: space-between; 
                            align-items: center; 
                            margin-bottom: 30px;
                            padding-bottom: 20px;
                            border-bottom: 2px solid var(--border-color);
                        }

                        table { 
                            width: 100%; 
                            border-collapse: collapse; 
                            background: var(--bg-box); 
                            margin-top: 20px; 
                            box-shadow: 0 4px 6px rgba(0,0,0,0.02);
                            border: 1px solid var(--border-color);
                            border-radius: 8px;
                            overflow: hidden;
                        }

                        th, td { 
                            padding: 15px; 
                            border: 1px solid var(--border-color); 
                            text-align: left; 
                        }

                        th { 
                            background: var(--bg-box); 
                            color: var(--text-muted);
                            font-weight: 600;
                            text-transform: uppercase;
                            font-size: 12px;
                            letter-spacing: 0.5px;
                        }

                        .toolbar { display: flex; gap: 10px; align-items: center; }
                        
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
                        }

                        .btn:hover { 
                            background: var(--primary-color); 
                            color: white;
                            border-color: var(--primary-color);
                        }
                        
                        /* Unified Action Buttons */
                        .btn-action { 
                            padding: 8px 14px; 
                            border: 1px solid var(--border-color); 
                            border-radius: 4px; 
                            cursor: pointer; 
                            color: var(--text-muted); 
                            background: var(--bg-box);
                            font-size: 13px; 
                            font-weight: 600; 
                            transition: all 0.2s; 
                        }
                        .btn-action:hover { 
                            background: var(--primary-color); 
                            color: white; 
                            border-color: var(--primary-color);
                            transform: translateY(-1px); 
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
                        .form-column { flex: 1; }
                        .chat-column { width: 320px; position: sticky; top: 0; }
                        
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
                    </style>
                    <script src="/js/robot-logo.js"></script>
                </head>
                <body>
                    <div class="header">
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <canvas id="botLogoDash" width="200" height="200" style="width: 50px; height: 50px;"></canvas>
                            <h2>Editor de Menú de WhatsApp</h2>
                        </div>
                        <div class="toolbar">
                            ${botSelector}
                            <button onclick="showVisual()" class="btn btn-purple">Visualizar</button>
                            <a href="/qr" class="btn btn-green">WhatsApp QR</a>
                            <a href="/refresh?botId=${botId}" class="btn btn-orange">Refrescar</a>
                            ${isAdmin ? `<a href="https://docs.google.com/spreadsheets/d/${service.spreadsheetId}" target="_blank" class="btn btn-blue">Abrir Sheet</a>` : ''}
                            <a href="/logout" class="btn btn-red">Salir</a>
                        </div>
                    </div>
                    
                    <table>
                        <thead>
                            <tr>
                                <th>Disparador</th>
                                <th>Título</th>
                                <th>Mensaje (Resumen)</th>
                                <th>Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>

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
                        <div class="modal-content" style="width: 800px;">
                            <span onclick="closeModal('addModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2>Agregar Nuevo Hijo</h2>
                            
                            <div class="modal-body-wrapper">
                                <div class="form-column">
                                    <div style="background: #e9ecef; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 5px solid #007bff;">
                                        <small style="color: #666; display: block; margin-bottom: 10px;">Vista previa de la relación:</small>
                                        <div id="addPreview" style="font-family: monospace; white-space: pre-wrap; font-size: 13px; max-height: 120px; overflow-y: auto; overflow-x: hidden;"></div>
                                    </div>

                                    <form action="/add" method="POST">
                                        <input type="hidden" name="botId" value="${botId}">
                                        <input type="hidden" id="addParentId" name="parentId">
                                        <input type="hidden" id="addId" name="id">
                                        <div class="form-group">
                                            <label>Disparador (Número/Letra):</label>
                                            <input type="text" id="addTrigger" name="trigger" placeholder="ej: 1" required oninput="updatePreview('add')">
                                        </div>
                                        <div class="form-group">
                                            <label>Título (En el menú):</label>
                                            <input type="text" id="addTitle" name="title" placeholder="ej: Hablar con Soporte" required oninput="updatePreview('add')">
                                        </div>
                                        <div class="form-group">
                                            <label>Mensaje (Respuesta):</label>
                                            <textarea id="addMessage" name="message" rows="3" placeholder="Mensaje que enviará el bot..." oninput="updatePreview('add')"></textarea>
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
                    </div>

                    <!-- Edit Modal -->
                    <div id="editModal" class="modal">
                        <div class="modal-content" style="width: 800px;">
                            <span onclick="closeModal('editModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2>Editar Nodo</h2>
                            
                            <div class="modal-body-wrapper">
                                <div class="form-column">
                                    <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 5px solid #ffc107;">
                                        <small style="color: #856404; display: block; margin-bottom: 10px;">Vista previa actual:</small>
                                        <div id="editPreview" style="font-family: monospace; white-space: pre-wrap; font-size: 13px; max-height: 120px; overflow-y: auto; overflow-x: hidden;"></div>
                                    </div>

                                    <form action="/save" method="POST">
                                        <input type="hidden" name="botId" value="${botId}">
                                        <input type="hidden" id="editIndex" name="index">
                                        <input type="hidden" id="editId" name="id">
                                        <input type="hidden" id="editParentId" name="parentId">
                                        <div class="form-group">
                                            <label>Disparador (Número/Letra):</label>
                                            <input type="text" id="editTrigger" name="trigger" required oninput="updatePreview('edit')">
                                        </div>
                                        <div class="form-group">
                                            <label>Título (En el menú):</label>
                                            <input type="text" id="editTitle" name="title" required oninput="updatePreview('edit')">
                                        </div>
                                        <div class="form-group">
                                            <label>Mensaje (Respuesta):</label>
                                            <textarea id="editMessage" name="message" rows="4" oninput="updatePreview('edit')"></textarea>
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

                    <script>
                        const menuData = ${JSON.stringify(menuData)};
                        const botId = "${botId}";
                        let currentParent = null;

                        drawRobot('botLogoDash');
                        
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
                                html += '<div><b>' + child.trigger + '. ' + child.title + '</b></div>';
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

                        function openAddModal(parentId) {
                            const parent = menuData.find(n => n.id === parentId) || { title: 'Raíz', id: 'root' };
                            currentParent = parent;
                            document.getElementById('addParentId').value = parentId;
                            
                            const childrenCount = menuData.filter(n => n.parentId === parentId).length;
                            const nextNumber = childrenCount + 1;

                            // Sugerencia de ID: nombre_padre + _opcion + X
                            const prefix = parentId === 'root' ? 'menu' : parentId;
                            document.getElementById('addId').value = \`\${prefix}_opcion\${nextNumber}\`;

                            // Sugerencia de Trigger: X
                            document.getElementById('addTrigger').value = nextNumber;

                            document.getElementById('addModal').style.display = "block";
                            updatePreview('add');
                        }

                        function openEditModal(index, id, parentId, trigger, title, message) {
                            document.getElementById('editIndex').value = index;
                            document.getElementById('editId').value = id;
                            document.getElementById('editParentId').value = parentId;
                            document.getElementById('editTrigger').value = (id === 'root' && (trigger === '' || trigger === '0' || !trigger)) ? 'Hola' : trigger;
                            document.getElementById('editTitle').value = title;
                            document.getElementById('editMessage').value = message;
                            
                            const parentInput = document.getElementById('editParentId');
                            if (id === 'root') {
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

                            currentParent = menuData.find(n => n.id === parentId) || { title: 'Raíz', id: 'root' };
                            document.getElementById('editModal').style.display = "block";
                            updatePreview('edit');
                        }

                        function updatePreview(type) {
                            const id = document.getElementById(type + 'Id').value || '...';
                            const trigger = document.getElementById(type + 'Trigger').value || '?';
                            const title = document.getElementById(type + 'Title').value || 'Nuevo Título';
                            const message = document.getElementById(type + 'Message').value || '';
                            const parentId = type === 'edit' ? document.getElementById('editParentId').value : document.getElementById('addParentId').value;

                            const parent = menuData.find(n => n.id === parentId) || { title: 'Raíz', id: 'root' };
                            const grandparent = parent.parentId ? (menuData.find(n => n.id === parent.parentId) || (parent.parentId === 'root' ? { title: 'Raíz', id: 'root' } : null)) : null;

                            // Preparar lista de items para mostrar (incluyendo el actual)
                            let displayItems = menuData
                                .filter(n => n.parentId === parent.id && n.id !== (type === 'edit' ? document.getElementById('editId').value : ''))
                                .map(n => ({ ...n, isCurrent: false }));
                            
                            displayItems.push({
                                id: id,
                                trigger: trigger,
                                title: title,
                                isCurrent: true
                            });

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
                                let itemLine = \`[ \${item.trigger}. \${item.title} ]\`;
                                
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

                            // --- WhatsApp Chat Preview ---
                            const chatBody = document.getElementById(type + 'ChatBody');
                            
                            // 1. Mensaje del Padre (Contexto)
                            let parentHtml = '';
                            if (parent) {
                                let parentContent = parent.message || '';
                                if (parent.id === 'root' && (!parentContent || parentContent === '')) {
                                    parentContent = 'Hola';
                                }

                                // Usar los mismos displayItems ordenados para la lista de opciones
                                let optionsList = '';
                                displayItems.forEach(item => {
                                    if (item.isCurrent) {
                                        optionsList += \`*\${trigger}*. \${title}\\n\`;
                                    } else {
                                        optionsList += \`*\${item.trigger}*. \${item.title}\\n\`;
                                    }
                                });

                                if (optionsList) {
                                    parentContent += '\\n\\n' + optionsList;
                                }

                                if (parentContent) {
                                    parentHtml = \`<div class="wa-bubble">\${parentContent.replace(/\\n/g, '<br>')}</div>\`;
                                }
                            }

                            // 2. Acción del Usuario (El trigger)
                            const userHtml = \`<div class="wa-bubble-user">\${trigger}</div>\`;

                            // 3. Respuesta Actual (Lo que se está editando)
                            let chatContent = message || '_Sin mensaje configurado_';
                            const subOptions = menuData.filter(n => n.parentId === id);
                            if (subOptions.length > 0) {
                                chatContent += '\\n\\n';
                                subOptions.forEach(opt => {
                                    chatContent += \`*\${opt.trigger}*. \${opt.title}\\n\`;
                                });
                                chatContent += \`\\n---\\n*v*. Volver atrás\\n*0*. Menú Principal\`;
                            }
                            const botHtml = \`<div class="wa-bubble">\${chatContent.replace(/\\n/g, '<br>')}</div>\`;

                            chatBody.innerHTML = parentHtml + userHtml + botHtml;
                            chatBody.scrollTop = chatBody.scrollHeight;
                        }

                        function confirmDelete(index) {
                            if (confirm('¿Estás seguro de que deseas borrar esta fila?')) {
                                window.location.href = '/delete/' + index + '?botId=' + botId;
                            }
                        }

                        function closeModal(modalId) {
                            document.getElementById(modalId).style.display = "none";
                        }
                    </script>
                </body>
                </html>
            `);
        });

        // Ruta para Borrar
        router.get('/delete/:index', async (req, res) => {
            const {
                service,
                botId
            } = await getServiceInfo(req);
            const index = req.params.index;
            try {
                const sheets = google.sheets({
                    version: 'v4',
                    auth: service.auth
                });
                await sheets.spreadsheets.values.clear({
                    spreadsheetId: service.spreadsheetId,
                    range: `${service.range.split('!')[0]}!A${index}:F${index}`,
                });
                service.clearCache();
                res.redirect(`/?botId=${botId}`);
            } catch (error) {
                console.error('Error al borrar en Sheets:', error);
                res.status(500).send('Error al borrar la fila.');
            }
        });

        // Ruta para Guardar
        router.post('/save', async (req, res) => {
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
                message
            } = req.body;

            try {
                const sheets = google.sheets({
                    version: 'v4',
                    auth: service.auth
                });
                await sheets.spreadsheets.values.update({
                    spreadsheetId: service.spreadsheetId,
                    range: `${service.range.split('!')[0]}!A${index}:F${index}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: {
                        values: [
                            [botId, id || '', parentId || '', title || '', message || '', trigger || '']
                        ]
                    }
                });
                service.clearCache();
                res.redirect(`/?botId=${botId}`);
            } catch (error) {
                console.error('Error al guardar en Sheets:', error);
                res.status(500).send('Error al guardar los datos.');
            }
        });

        // Ruta para Agregar
        router.post('/add', async (req, res) => {
            const {
                service,
                botId
            } = await getServiceInfo(req);
            const {
                id,
                parentId,
                trigger,
                title,
                message
            } = req.body;

            try {
                const sheets = google.sheets({
                    version: 'v4',
                    auth: service.auth
                });
                const sheetName = service.range.split('!')[0];

                const response = await sheets.spreadsheets.values.get({
                    spreadsheetId: service.spreadsheetId,
                    range: `${sheetName}!A:A`,
                });

                const rows = response.data.values || [];
                let nextRow = rows.length + 1;

                for (let i = 1; i < rows.length; i++) {
                    if (!rows[i] || rows[i].length === 0 || rows[i][0] === '') {
                        nextRow = i + 1;
                        break;
                    }
                }

                if (nextRow > rows.length) nextRow = rows.length + 1;
                if (rows.length === 0) nextRow = 2;
                if (rows.length === 1 && rows[0][0]) nextRow = 2;

                await sheets.spreadsheets.values.update({
                    spreadsheetId: service.spreadsheetId,
                    range: `${sheetName}!A${nextRow}:F${nextRow}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: {
                        values: [
                            [botId, id || '', parentId || '', title || '', message || '', trigger || '']
                        ]
                    }
                });

                service.clearCache();
                res.redirect(`/?botId=${botId}`);
            } catch (error) {
                console.error('Error al agregar a Sheets:', error);
                res.status(500).send('Error al agregar los datos.');
            }
        });

        return router;
    }
}

module.exports = new Dashboard();