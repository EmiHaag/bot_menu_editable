const { google } = require('googleapis');
const GoogleAuthBase = require('./googleAuthBase');

const GREEN_RGB = { red: 0, green: 188 / 255, blue: 125 / 255 };
const MAX_DATA_ROWS = 2000;

class OrderService extends GoogleAuthBase {
    constructor() {
        super();
        this.spreadsheetIds = {};
        this.sheetIds = {};
    }

    get sheets() {
        return google.sheets({ version: 'v4', auth: this.getAuthClient() });
    }

    get drive() {
        return google.drive({ version: 'v3', auth: this.getAuthClient() });
    }

    async _getOrInitSheetMeta(clientId) {
        if (this.sheetIds[clientId]) return this.sheetIds[clientId];

        const spreadsheetId = this.spreadsheetIds[clientId] || await this.getPedidosSpreadsheetId(clientId);
        if (!spreadsheetId) return null;

        const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
        const sheet = spreadsheet.data.sheets[0];
        const meta = {
            spreadsheetId,
            sheetId: sheet.properties.sheetId,
            sheetTitle: sheet.properties.title,
        };
        this.sheetIds[clientId] = meta;
        return meta;
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

        const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId });
        const defaultSheetId = spreadsheet.data.sheets[0].properties.sheetId;
        const sheetTitle = this._sanitizeSheetTitle(clientId);

        await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        updateSheetProperties: {
                            properties: {
                                sheetId: defaultSheetId,
                                title: sheetTitle,
                            },
                            fields: 'title',
                        },
                    },
                ],
            },
        });

        this.sheetIds[clientId] = { spreadsheetId, sheetId: defaultSheetId, sheetTitle };

        await this.sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetTitle}!A1:F1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [['Fecha/Hora', 'WhatsApp', 'Items', 'Total', 'Datos del Cliente', 'Cliente']],
            },
        });

        await this._applyFormatting(spreadsheetId, defaultSheetId, sheetTitle);

        try {
            await this.drive.permissions.create({
                fileId: spreadsheetId,
                resource: {
                    role: 'reader',
                    type: 'anyone',
                },
            });
        } catch (e) {
            console.warn('[OrderService] No se pudo hacer público el Pedidos:', e.message);
        }

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

    async _applyFormatting(spreadsheetId, sheetId, sheetTitle) {
        const range = `${sheetTitle}!A1:F${MAX_DATA_ROWS}`;

        await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: {
                                sheetId,
                                startRowIndex: 0,
                                endRowIndex: 1,
                                startColumnIndex: 0,
                                endColumnIndex: 6,
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: GREEN_RGB,
                                    textFormat: {
                                        bold: true,
                                        foregroundColor: { red: 0, green: 0, blue: 0 },
                                    },
                                    horizontalAlignment: 'CENTER',
                                },
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
                        },
                    },
                    {
                        addBanding: {
                            bandedRange: {
                                range: {
                                    sheetId,
                                    startRowIndex: 0,
                                    endRowIndex: MAX_DATA_ROWS,
                                    startColumnIndex: 0,
                                    endColumnIndex: 6,
                                },
                                rowProperties: {
                                    headerColor: GREEN_RGB,
                                    firstBandColor: { red: 1, green: 1, blue: 1 },
                                    secondBandColor: { red: 245 / 255, green: 245 / 255, blue: 245 / 255 },
                                },
                            },
                        },
                    },
                    {
                        updateBorders: {
                            range: {
                                sheetId,
                                startRowIndex: 0,
                                endRowIndex: MAX_DATA_ROWS,
                                startColumnIndex: 0,
                                endColumnIndex: 6,
                            },
                            top: { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                            bottom: { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                            left: { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                            right: { style: 'SOLID', color: { red: 0.8, green: 0.8, blue: 0.8 } },
                        },
                    },
                ],
            },
        });
    }

    async deletePedidosSpreadsheet(clientId) {
        const spreadsheetId = this.spreadsheetIds[clientId] || await this.getPedidosSpreadsheetId(clientId);
        if (!spreadsheetId) return false;

        const driveService = require('./googleDriveService');
        const result = await driveService.deleteFile(spreadsheetId);
        delete this.spreadsheetIds[clientId];
        delete this.sheetIds[clientId];
        return result;
    }

    async saveOrder(clientId, jid, items, datosText) {
        let spreadsheetId = this.spreadsheetIds[clientId] || await this.getPedidosSpreadsheetId(clientId);
        if (!spreadsheetId) {
            spreadsheetId = await this.createPedidosSpreadsheet(clientId);
        }

        const meta = await this._getOrInitSheetMeta(clientId);
        if (!meta) return;

        const { sheetId, sheetTitle } = meta;
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
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            insertDimension: {
                                range: {
                                    sheetId,
                                    dimension: 'ROWS',
                                    startIndex: 1,
                                    endIndex: 2,
                                },
                                inheritFromBefore: false,
                            },
                        },
                    ],
                },
            });

            await this.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetTitle}!A2:F2`,
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
