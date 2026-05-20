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
                const cleanMessage = (node.message || "")
                    .replace('##PEDIDO##', '')
                    .replace('##CANTIDAD##', '')
                    .replace('##FINALIZAR##', '')
                    .replace('##DATOS##', '')
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
                                <th>Precio</th>
                                <th>Pedido</th>
                                <th>Cant.</th>
                                <th>Fin</th>
                                <th>Datos</th>
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
                                        <div class="form-group">
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
                                        <div class="form-group" style="display: flex; gap: 10px; margin-bottom: 20px;">
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #f8f9fa; padding: 10px; border-radius: 6px; border: 1px dashed var(--border-color);">
                                                <input type="checkbox" id="addIsOrder" onchange="toggleOrderTag('add', '##PEDIDO##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="addIsOrder" style="margin-bottom: 0; cursor: pointer; font-size: 13px;">¿Crear pedido?</label>
                                            </div>
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #eefbff; padding: 10px; border-radius: 6px; border: 1px dashed #bee5eb;">
                                                <input type="checkbox" id="addIsQty" onchange="toggleOrderTag('add', '##CANTIDAD##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="addIsQty" style="margin-bottom: 0; cursor: pointer; font-size: 13px;">¿Pedir cantidad?</label>
                                            </div>
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #f3f0ff; padding: 10px; border-radius: 6px; border: 1px dashed #d1d1ff;">
                                                <input type="checkbox" id="addIsFinal" onchange="toggleOrderTag('add', '##FINALIZAR##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="addIsFinal" style="margin-bottom: 0; cursor: pointer; font-size: 13px;">¿Finalizar?</label>
                                            </div>
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #fff4e5; padding: 10px; border-radius: 6px; border: 1px dashed #ff9800;">
                                                <input type="checkbox" id="addIsData" onchange="toggleOrderTag('add', '##DATOS##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="addIsData" style="margin-bottom: 0; cursor: pointer; font-size: 13px;">Capturar dato y continuar</label>
                                            </div>
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
                                        <div class="form-group" id="editTagsGroup" style="display: flex; gap: 10px; margin-bottom: 20px;">
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #fff3cd; padding: 10px; border-radius: 6px; border: 1px dashed #ffc107;">
                                                <input type="checkbox" id="editIsOrder" onchange="toggleOrderTag('edit', '##PEDIDO##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="editIsOrder" style="margin-bottom: 0; cursor: pointer; color: #856404; font-size: 13px;">¿Crear pedido?</label>
                                            </div>
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #eefbff; padding: 10px; border-radius: 6px; border: 1px dashed #bee5eb;">
                                                <input type="checkbox" id="editIsQty" onchange="toggleOrderTag('edit', '##CANTIDAD##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="editIsQty" style="margin-bottom: 0; cursor: pointer; color: #0c5460; font-size: 13px;">¿Pedir cantidad?</label>
                                            </div>
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #f3f0ff; padding: 10px; border-radius: 6px; border: 1px dashed #d1d1ff;">
                                                <input type="checkbox" id="editIsFinal" onchange="toggleOrderTag('edit', '##FINALIZAR##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="editIsFinal" style="margin-bottom: 0; cursor: pointer; color: #5227cc; font-size: 13px;">¿Finalizar?</label>
                                            </div>
                                            <div style="flex: 1; display: flex; align-items: center; gap: 10px; background: #fff4e5; padding: 10px; border-radius: 6px; border: 1px dashed #ff9800;">
                                                <input type="checkbox" id="editIsData" onchange="toggleOrderTag('edit', '##DATOS##')" style="width: 20px; height: 20px; cursor: pointer;">
                                                <label for="editIsData" style="margin-bottom: 0; cursor: pointer; color: #856404; font-size: 13px;">¿Capturar dato?</label>
                                            </div>
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

                        function openAddModal(idx) {
                            const parent = menuData[idx] || { title: 'Raíz', id: 'root' };
                            const parentId = parent.id;
                            currentParent = parent;
                            document.getElementById('addParentId').value = parentId;
                            
                            const childrenCount = menuData.filter(n => n.parentId === parentId).length;
                            const nextNumber = childrenCount + 1;

                            // Sugerencia de ID: nombre_padre + _opcion + X
                            const prefix = parentId === 'root' ? 'menu' : parentId;
                            document.getElementById('addId').value = '\${prefix}_opcion\${nextNumber}';

                            // Sugerencia de Trigger: X
                            document.getElementById('addTrigger').value = nextNumber;
                            document.getElementById('addPrice').value = '';

                            document.getElementById('addModal').style.display = "block";
                            updatePreview('add');
                        }

                        function openEditModal(idx) {
                            const node = menuData[idx];
                            if (!node) return;

                            const isOrder = node.message && node.message.includes('##PEDIDO##');
                            const isQty = node.message && node.message.includes('##CANTIDAD##');
                            const isFinal = node.message && node.message.includes('##FINALIZAR##');
                            const isData = node.message && node.message.includes('##DATOS##');

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

                            const strictGroup = document.getElementById('strictTriggerGroup');
                            const strictCheckbox = document.getElementById('editStrictTrigger');
                            const titleInput = document.getElementById('editTitle');
                            const editTriggerGroup = document.getElementById('editTriggerGroup');
                            const editTitleGroup = document.getElementById('editTitleGroup');
                            const editTagsGroup = document.getElementById('editTagsGroup');

                            if (node.id === 'root') {
                                strictGroup.style.display = 'block';
                                strictCheckbox.checked = node.strictTrigger === 'true';
                                editTriggerGroup.style.display = 'flex'; // Cambiado de none a flex
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
                            let chatContent = (message || '_Sin mensaje configurado_')
                                .replace('##PEDIDO##', '')
                                .replace('##CANTIDAD##', '')
                                .replace('##FINALIZAR##', '')
                                .replace('##DATOS##', '')
                                .replace('_Este es el nodo de inicio, su mensaje no se muestra directamente en el bot._', '')
                                .trim();
                            
                            const subOptions = menuData.filter(n => n.parentId === id);
                            if (subOptions.length > 0) {
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
                                window.location.href = '/delete/' + index + '?botId=' + botId + '&nodeId=' + nodeId;
                            };

                            document.getElementById('deleteConfirmModal').style.display = "block";
                        }

                        function closeModal(modalId) {
                            document.getElementById(modalId).style.display = "none";
                        }

                        function toggleOrderTag(type, tag) {
                            const messageEl = document.getElementById(type + 'Message');
                            const isOrderCheckbox = document.getElementById(type === 'edit' ? 'editIsOrder' : 'addIsOrder');
                            const isQtyCheckbox = document.getElementById(type === 'edit' ? 'editIsQty' : 'addIsQty');
                            const isFinalCheckbox = document.getElementById(type === 'edit' ? 'editIsFinal' : 'addIsFinal');
                            const isDataCheckbox = document.getElementById(type === 'edit' ? 'editIsData' : 'addIsData');
                            
                            let currentVal = messageEl.value
                                .replace('##PEDIDO##', '')
                                .replace('##CANTIDAD##', '')
                                .replace('##FINALIZAR##', '')
                                .replace('##DATOS##', '')
                                .trim();
                            
                            if (tag === '##PEDIDO##' && isOrderCheckbox.checked) {
                                isQtyCheckbox.checked = false;
                                isFinalCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##PEDIDO##';
                            } else if (tag === '##CANTIDAD##' && isQtyCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isFinalCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##CANTIDAD##';
                            } else if (tag === '##FINALIZAR##' && isFinalCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isQtyCheckbox.checked = false;
                                isDataCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##FINALIZAR##';
                            } else if (tag === '##DATOS##' && isDataCheckbox.checked) {
                                isOrderCheckbox.checked = false;
                                isQtyCheckbox.checked = false;
                                isFinalCheckbox.checked = false;
                                messageEl.value = currentVal + (currentVal ? '\\n\\n' : '') + '##DATOS##';
                            } else {
                                messageEl.value = currentVal;
                            }
                            
                            updatePreview(type);
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
            const nodeId = req.query.nodeId;
            try {
                if (nodeId) {
                    await service.deleteNodeAndChildren(nodeId);
                } else {
                    const sheets = google.sheets({
                        version: 'v4',
                        auth: service.auth
                    });
                    await sheets.spreadsheets.values.clear({
                        spreadsheetId: service.spreadsheetId,
                        range: `${service.range.split('!')[0]}!A${index}:H${index}`,
                    });
                    service.clearCache();
                }
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
                message,
                price,
                strictTrigger
            } = req.body;

            try {
                const sheets = google.sheets({
                    version: 'v4',
                    auth: service.auth
                });
                await sheets.spreadsheets.values.update({
                    spreadsheetId: service.spreadsheetId,
                    range: `${service.range.split('!')[0]}!A${index}:H${index}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: {
                        values: [
                            [botId, id || '', parentId || '', title || '', message || '', trigger || '', price || '', strictTrigger || 'false']
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
                message,
                price
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
                    range: `${sheetName}!A${nextRow}:H${nextRow}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: {
                        values: [
                            [botId, id || '', parentId || '', title || '', message || '', trigger || '', price || '', 'false']
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
