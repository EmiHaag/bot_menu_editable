const express = require('express');
const bodyParser = require('body-parser');
const GoogleSheetsService = require('../services/googleSheetsService');
const {
    google
} = require('googleapis');
const botsConfig = require('../config/bots');
const app = express();
const port = 3000;

class Dashboard {
    constructor() {
        this.services = {};
        botsConfig.forEach(bot => {
            this.services[bot.id] = new GoogleSheetsService({
                clientId: bot.id,
                spreadsheetId: bot.spreadsheetId,
                credentials: bot.credentials
            });
        });

        // Aplicar middleware de parseo de cuerpo
        app.use(bodyParser.urlencoded({
            extended: true
        }));
        app.use(bodyParser.json());
    }

    start() {
        // Middleware to get the correct service based on botId query param
        const getService = (req) => {
            const botId = req.query.botId || (req.body && req.body.botId) || botsConfig[0].id;
            return {
                service: this.services[botId],
                botId
            };
        };

        // Ruta para refrescar caché
        app.get('/refresh', (req, res) => {
            const {
                service,
                botId
            } = getService(req);
            if (service) service.clearCache();
            res.redirect(`/?botId=${botId}`);
        });

        // Vista Principal
        app.get('/', async (req, res) => {
            const {
                service,
                botId
            } = getService(req);

            if (!service) {
                return res.status(404).send('Bot no encontrado.');
            }

            const menuData = await service.getMenuData();

            let botOptions = botsConfig.map(bot =>
                `<option value="${bot.id}" ${bot.id === botId ? 'selected' : ''}>${bot.id}</option>`
            ).join('');

            let rowsHtml = menuData.map((node) => `
                <tr>
                    <td><code>${node.id}</code></td>
                    <td><code>${node.parentId}</code></td>
                    <td><b>${node.trigger}</b></td>
                    <td>${node.title}</td>
                    <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${node.message}</td>
                    <td>
                        <div style="display: flex; gap: 5px;">
                            <button type="button" onclick="openEditModal('${node.rowIndex}', '${node.id}', '${node.parentId}', '${node.trigger}', '${node.title}', \`${node.message.replace(/'/g, "").replace(/"/g, '').replace(/\n/g, "\\n")}\`)" class="btn-action btn-orange">Editar</button>
                            <button type="button" onclick="openAddModal('${node.id}')" class="btn-action btn-blue">+ Hijo</button>
                            <button type="button" onclick="confirmDelete('${node.rowIndex}')" class="btn-action btn-red">Borrar</button>
                        </div>
                    </td>
                </tr>
            `).join('');

            res.send(`
                <html>
                <head>
                    <title>Editor de Bot - Cliente: ${botId}</title>
                    <style>
                        body { font-family: sans-serif; margin: 40px; background: #f4f4f9; }
                        table { width: 100%; border-collapse: collapse; background: white; margin-top: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
                        th, td { padding: 12px; border: 1px solid #ddd; text-align: left; }
                        th { background: #007bff; color: white; }
                        .header { display: flex; justify-content: space-between; align-items: center; }
                        .toolbar { display: flex; gap: 10px; align-items: center; }
                        .btn { padding: 10px 15px; text-decoration: none; border-radius: 5px; border: none; cursor: pointer; color: white; font-weight: bold; font-size: 14px; }
                        .btn-blue { background: #007bff; }
                        .btn-orange { background: #fd7e14; }
                        .btn-purple { background: #6f42c1; }
                        .btn-green { background: #28a745; }
                        .btn-red { background: #dc3545; }
                        .btn-action { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; color: white; font-size: 12px; font-weight: bold; transition: opacity 0.2s; }
                        .btn-action:hover { opacity: 0.8; }
                        select { padding: 10px; border-radius: 5px; border: 1px solid #ddd; font-weight: bold; }
                        
                        /* Modal Styles */
                        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); }
                        .modal-content { background: white; margin: 2% auto; padding: 25px; width: 50%; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
                        .modal-content h2 { margin-top: 0; color: #333; }
                        .form-group { margin-bottom: 15px; }
                        .form-group label { display: block; margin-bottom: 5px; font-weight: bold; color: #555; }
                        .form-group input, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
                        
                        .tree ul { padding-top: 20px; position: relative; transition: all 0.5s; }
                        .tree li { float: left; text-align: center; list-style-type: none; position: relative; padding: 20px 5px 0 5px; transition: all 0.5s; }
                        .tree li::before, .tree li::after { content: ''; position: absolute; top: 0; right: 50%; border-top: 1px solid #ccc; width: 50%; height: 20px; }
                        .tree li::after { right: auto; left: 50%; border-left: 1px solid #ccc; }
                        .tree li:only-child::after, .tree li:only-child::before { display: none; }
                        .tree li:only-child { padding-top: 0; }
                        .tree li:first-child::before, .tree li:last-child::after { border: 0 none; }
                        .tree li:last-child::before { border-right: 1px solid #ccc; border-radius: 0 5px 0 0; }
                        .tree li:first-child::after { border-radius: 5px 0 0 0; }
                        .tree ul ul::before { content: ''; position: absolute; top: 0; left: 50%; border-left: 1px solid #ccc; width: 0; height: 20px; }
                        .tree li div { border: 1px solid #ccc; padding: 5px 10px; text-decoration: none; color: #666; font-size: 11px; display: inline-block; border-radius: 5px; background: #fff; }
                    </style>
                </head>
                <body>
                    <div class="header">
                        <h1>Editor de Menú WhatsApp</h1>
                        <div class="toolbar">
                            <label>Bot:</label>
                            <select onchange="window.location.href='/?botId=' + this.value">
                                ${botOptions}
                            </select>
                            <button onclick="showVisual()" class="btn btn-purple">Visualizar Estructura</button>
                            <a href="/refresh?botId=${botId}" class="btn btn-orange">Refrescar Datos</a>
                            <a href="https://docs.google.com/spreadsheets/d/${service.spreadsheetId}" target="_blank" class="btn btn-blue">Abrir Sheet</a>
                        </div>
                    </div>
                    
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>ParentID</th>
                                <th>Trigger</th>
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
                        <div class="modal-content" style="width: 80%; max-height: 80%; overflow-y: auto;">
                            <span onclick="closeModal('visualModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2>Estructura Jerárquica del Bot</h2>
                            <div class="tree" id="treeContainer"></div>
                        </div>
                    </div>

                    <!-- Add Child Modal -->
                    <div id="addModal" class="modal">
                        <div class="modal-content">
                            <span onclick="closeModal('addModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2>Agregar Nuevo Hijo</h2>
                            
                            <div style="background: #e9ecef; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 5px solid #007bff;">
                                <small style="color: #666; display: block; margin-bottom: 10px;">Vista previa de la relación:</small>
                                <div id="addPreview" style="font-family: monospace; white-space: pre;"></div>
                            </div>

                            <form action="/add" method="POST">
                                <input type="hidden" name="botId" value="${botId}">
                                <div class="form-group">
                                    <label>Parent ID (Padre):</label>
                                    <input type="text" id="addParentId" name="parentId" readonly style="background: #eee;">
                                </div>
                                <div class="form-group">
                                    <label>Nuevo ID (Único):</label>
                                    <input type="text" id="addId" name="id" placeholder="ej: soporte_tecnico" required oninput="updatePreview('add')">
                                </div>
                                <div class="form-group">
                                    <label>Trigger (Número/Letra):</label>
                                    <input type="text" id="addTrigger" name="trigger" placeholder="ej: 1" required oninput="updatePreview('add')">
                                </div>
                                <div class="form-group">
                                    <label>Título (En el menú):</label>
                                    <input type="text" id="addTitle" name="title" placeholder="ej: Hablar con Soporte" required oninput="updatePreview('add')">
                                </div>
                                <div class="form-group">
                                    <label>Mensaje (Respuesta):</label>
                                    <textarea name="message" rows="3" placeholder="Mensaje que enviará el bot..."></textarea>
                                </div>
                                <button type="submit" class="btn btn-green" style="width: 100%;">Crear Nodo Hijo</button>
                            </form>
                        </div>
                    </div>

                    <!-- Edit Modal -->
                    <div id="editModal" class="modal">
                        <div class="modal-content">
                            <span onclick="closeModal('editModal')" style="float:right; cursor:pointer; font-size:24px;">&times;</span>
                            <h2>Editar Nodo</h2>
                            
                            <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 5px solid #ffc107;">
                                <small style="color: #856404; display: block; margin-bottom: 10px;">Vista previa actual:</small>
                                <div id="editPreview" style="font-family: monospace; white-space: pre;"></div>
                            </div>

                            <form action="/save" method="POST">
                                <input type="hidden" name="botId" value="${botId}">
                                <input type="hidden" id="editIndex" name="index">
                                <div class="form-group">
                                    <label>ID (Único):</label>
                                    <input type="text" id="editId" name="id" required oninput="updatePreview('edit')">
                                </div>
                                <div class="form-group">
                                    <label>Parent ID (Padre):</label>
                                    <input type="text" id="editParentId" name="parentId" required oninput="updatePreview('edit')">
                                </div>
                                <div class="form-group">
                                    <label>Trigger (Número/Letra):</label>
                                    <input type="text" id="editTrigger" name="trigger" required oninput="updatePreview('edit')">
                                </div>
                                <div class="form-group">
                                    <label>Título (En el menú):</label>
                                    <input type="text" id="editTitle" name="title" required oninput="updatePreview('edit')">
                                </div>
                                <div class="form-group">
                                    <label>Mensaje (Respuesta):</label>
                                    <textarea id="editMessage" name="message" rows="4"></textarea>
                                </div>
                                <button type="submit" class="btn btn-green" style="width: 100%;">Guardar Cambios</button>
                            </form>
                        </div>
                    </div>

                    <script>
                        const menuData = ${JSON.stringify(menuData)};
                        const botId = "${botId}";
                        let currentParent = null;
                        
                        function buildTree(parentId) {
                            const children = menuData.filter(n => n.parentId === parentId);
                            if (children.length === 0) return '';
                            
                            let html = '<ul>';
                            children.forEach(child => {
                                html += '<li>';
                                html += '<div><b>' + child.trigger + '. ' + child.title + '</b><br><small>ID: ' + child.id + '</small></div>';
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
                            currentParent = menuData.find(n => n.id === parentId) || { title: 'Raíz', id: 'root' };
                            document.getElementById('addParentId').value = parentId;
                            document.getElementById('addModal').style.display = "block";
                            updatePreview('add');
                        }

                        function openEditModal(index, id, parentId, trigger, title, message) {
                            document.getElementById('editIndex').value = index;
                            document.getElementById('editId').value = id;
                            document.getElementById('editParentId').value = parentId;
                            document.getElementById('editTrigger').value = trigger;
                            document.getElementById('editTitle').value = title;
                            document.getElementById('editMessage').value = message;
                            
                            currentParent = menuData.find(n => n.id === parentId) || { title: 'Raíz', id: 'root' };
                            document.getElementById('editModal').style.display = "block";
                            updatePreview('edit');
                        }

                        function updatePreview(type) {
                            const id = document.getElementById(type + 'Id').value || '...';
                            const trigger = document.getElementById(type + 'Trigger').value || '?';
                            const title = document.getElementById(type + 'Title').value || 'Nuevo Título';
                            const parentId = type === 'edit' ? document.getElementById('editParentId').value : document.getElementById('addParentId').value;
                            
                            const parent = menuData.find(n => n.id === parentId) || { title: 'Raíz', id: 'root' };
                            const siblings = menuData.filter(n => n.parentId === parent.id && n.id !== (type === 'edit' ? document.getElementById('editId').value : ''));
                            
                            let siblingText = '';
                            siblings.forEach(s => {
                                siblingText += \`  ├── [ \${s.trigger}. \${s.title} ] (ID: \${s.id})\\n\`;
                            });

                            const preview = document.getElementById(type + 'Preview');
                            preview.innerHTML = \`[ \${parent.title} ]\\n\${siblingText}  └── [ \${trigger}. \${title} ] (ID: \${id})\`;
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
        app.get('/delete/:index', async (req, res) => {
            const {
                service,
                botId
            } = getService(req);
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
        app.post('/save', async (req, res) => {
            const {
                service,
                botId
            } = getService(req);
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
        app.post('/add', async (req, res) => {
            const {
                service,
                botId
            } = getService(req);
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

        app.listen(port, () => {
            console.log(`📊 Dashboard editable en: http://localhost:${port}`);
        });
    }
}

module.exports = new Dashboard();