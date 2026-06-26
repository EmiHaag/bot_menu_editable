const { google } = require('googleapis');
const GoogleAuthBase = require('./googleAuthBase');

class OrderService extends GoogleAuthBase {
    constructor() {
        super();
        this.spreadsheetIds = {};
    }

    get sheets() {
        return google.sheets({ version: 'v4', auth: this.getAuthClient() });
    }

    get drive() {
        return google.drive({ version: 'v3', auth: this.getAuthClient() });
    }

    async getPedidosSpreadsheetId(clientId) {
        if (this.spreadsheetIds[clientId]) return this.spreadsheetIds[clientId];

        const driveService = require('./googleDriveService');
        const folderId = await driveService.getOrCreateFolder('bots');
        const sheetName = `${clientId}_Pedidos`;

        const response = await this.drive.files.list({
            q: `name = '${sheetName}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and '${folderId}' in parents`,
            fields: 'files(id, name)',
        });

        if (response.data.files.length > 0) {
            this.spreadsheetIds[clientId] = response.data.files[0].id;
        }

        return this.spreadsheetIds[clientId] || null;
    }

    async createPedidosSpreadsheet(clientId) {
        const existingId = await this.getPedidosSpreadsheetId(clientId);
        if (existingId) return existingId;

        const driveService = require('./googleDriveService');
        const folderId = await driveService.getOrCreateFolder('bots');
        const sheetName = `${clientId}_Pedidos`;

        const newFile = await this.drive.files.create({
            resource: {
                name: sheetName,
                mimeType: 'application/vnd.google-apps.spreadsheet',
                parents: [folderId],
            },
            fields: 'id',
        });

        const spreadsheetId = newFile.data.id;
        this.spreadsheetIds[clientId] = spreadsheetId;

        // Renombrar la hoja por defecto (Sheet1/Hoja1) y poner cabeceras
        const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
        const defaultSheetId = spreadsheet.data.sheets[0].properties.sheetId;

        await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        updateSheetProperties: {
                            properties: {
                                sheetId: defaultSheetId,
                                title: this._sanitizeSheetTitle(clientId),
                            },
                            fields: 'title',
                        },
                    },
                ],
            },
        });

        await this.sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${this._sanitizeSheetTitle(clientId)}!A1:F1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [['Fecha/Hora', 'WhatsApp', 'Items', 'Total', 'Datos del Cliente', 'Cliente']],
            },
        });

        if (process.env.ADMIN_EMAIL) {
            try {
                await this.drive.permissions.create({
                    fileId: spreadsheetId,
                    resource: {
                        role: 'writer',
                        type: 'user',
                        emailAddress: process.env.ADMIN_EMAIL,
                    },
                });
            } catch (e) {
                console.warn('[OrderService] No se pudo compartir Pedidos con admin:', e.message);
            }
        }

        return spreadsheetId;
    }

    async deletePedidosSpreadsheet(clientId) {
        const spreadsheetId = this.spreadsheetIds[clientId] || await this.getPedidosSpreadsheetId(clientId);
        if (!spreadsheetId) return false;

        const driveService = require('./googleDriveService');
        const result = await driveService.deleteFile(spreadsheetId);
        delete this.spreadsheetIds[clientId];
        return result;
    }

    async saveOrder(clientId, jid, items, datosText) {
        let spreadsheetId = this.spreadsheetIds[clientId] || await this.getPedidosSpreadsheetId(clientId);
        if (!spreadsheetId) {
            spreadsheetId = await this.createPedidosSpreadsheet(clientId);
        }

        const sheetTitle = this._sanitizeSheetTitle(clientId);
        const phone = jid ? jid.split('@')[0] : 'desconocido';

        const itemsText = items.map(item => {
            if (typeof item === 'string') return item;
            const priceStr = item.price > 0 ? ` ($${item.price * item.quantity})` : '';
            return `${item.quantity} x ${item.text}${priceStr}`;
        }).join('\n');

        let total = 0;
        for (const item of items) {
            if (typeof item === 'object') {
                total += item.price * item.quantity;
            }
        }

        const now = new Date().toLocaleString('es-AR');

        try {
            await this.sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetTitle}!A:F`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[now, phone, itemsText, `$${total}`, datosText || '', clientId]],
                },
            });

            console.log(`[OrderService] Pedido guardado para ${clientId} - Total: $${total}`);
        } catch (error) {
            console.error('[OrderService] Error guardando pedido:', error.message);
        }
    }

    _sanitizeSheetTitle(title) {
        return String(title).replace(/[\/\\\?\*\[\]']/g, '_').slice(0, 100);
    }
}

module.exports = new OrderService();
