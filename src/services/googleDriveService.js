const { google } = require('googleapis');
const GoogleAuthBase = require('./googleAuthBase');

class GoogleDriveService extends GoogleAuthBase {
    constructor() {
        super();
    }

    get drive() {
        return google.drive({ version: 'v3', auth: this.getAuthClient() });
    }

    get sheets() {
        return google.sheets({ version: 'v4', auth: this.getAuthClient() });
    }

    async getOrCreateFolder(folderName) {
        try {
            const drive = this.drive;
            // Buscar si la carpeta ya existe
            const response = await drive.files.list({
                q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id, name)',
            });

            if (response.data.files.length > 0) {
                return response.data.files[0].id;
            }

            // Si no existe, crearla
            const fileMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
            };
            const folder = await drive.files.create({
                resource: fileMetadata,
                fields: 'id',
            });
            console.log(`Carpeta '${folderName}' creada con ID: ${folder.data.id}`);
            return folder.data.id;
        } catch (error) {
            console.error('Error en getOrCreateFolder:', error);
            throw error;
        }
    }

    async createClientSpreadsheet(clientData, folderId) {
        try {
            const drive = this.drive;
            const { idCliente, nombreCliente, user, password } = clientData;
            const fileMetadata = {
                name: `${nombreCliente}_Menu`,
                mimeType: 'application/vnd.google-apps.spreadsheet',
                parents: [folderId],
            };

            const spreadsheet = await drive.files.create({
                resource: fileMetadata,
                fields: 'id',
            });

            const spreadsheetId = spreadsheet.data.id;
            console.log(`Spreadsheet creado para ${nombreCliente} con ID: ${spreadsheetId}`);

            // En OAuth2 (tu cuenta personal), tú ya eres el dueño.
            // No hace falta transferir propiedad. Solo compartir si hay un ADMIN_EMAIL diferente.
            if (process.env.ADMIN_EMAIL) {
                try {
                    await drive.permissions.create({
                        fileId: spreadsheetId,
                        resource: {
                            role: 'writer',
                            type: 'user',
                            emailAddress: process.env.ADMIN_EMAIL
                        }
                    });
                    console.log(`Archivo compartido con: ${process.env.ADMIN_EMAIL}`);
                } catch (permError) {
                    console.warn('No se pudo compartir el archivo:', permError.message);
                }
            }

            // Inicializar cabeceras, hoja "Menu" y hoja "Config"
            await this.initializeSpreadsheet(spreadsheetId, clientData);

            return spreadsheetId;
        } catch (error) {
            console.error('Error en createClientSpreadsheet:', error);
            throw error;
        }
    }

    async initializeSpreadsheet(spreadsheetId, clientData) {
        try {
            const sheets = this.sheets;
            const { idCliente, nombreCliente, user, password } = clientData;

            // 1. Renombrar la primera hoja a "Menu" y agregar "Config"
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            updateSheetProperties: {
                                properties: {
                                    sheetId: 0,
                                    title: 'Menu'
                                },
                                fields: 'title'
                            }
                        },
                        {
                            addSheet: {
                                properties: {
                                    title: 'Config'
                                }
                            }
                        }
                    ]
                }
            });

            // 2. Agregar cabeceras a "Menu"
            const menuHeaders = [['ID_client', 'ID', 'ParentID', 'Title', 'Message', 'Trigger', 'Price', 'strictTrigger']];
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Menu!A1:H1',
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: menuHeaders
                }
            });

            // 3. Agregar fila inicial root a "Menu"
            const rootRow = [[idCliente, 'root', '', 'Inicio', 'Hola bienvenido a ' + nombreCliente, '0', '', 'false']];
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Menu!A2:H2',
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: rootRow
                }
            });

            // 4. Agregar cabeceras y datos a "Config"
            const configData = [
                ['Campo', 'Valor'],
                ['ID_Cliente', idCliente],
                ['Nombre_Negocio', nombreCliente],
                ['Usuario', user],
                ['Password', password],
                ['Fecha_Creacion', new Date().toLocaleDateString()]
            ];
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: 'Config!A1:B6',
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: configData
                }
            });

            console.log(`Spreadsheet ${spreadsheetId} inicializado con Menu y Config.`);
        } catch (error) {
            console.error('Error en initializeSpreadsheet:', error);
            throw error;
        }
    }

    async deleteFile(fileId) {
        try {
            if (!fileId) return;
            const drive = this.drive;
            await drive.files.update({
                fileId: fileId,
                resource: { trashed: true }
            });
            console.log(`Archivo ${fileId} movido a la papelera.`);
            return true;
        } catch (error) {
            console.error('[GoogleDriveService] Error deleting file:', error.message);
            // No lanzamos error para que no bloquee el borrado del usuario si falla el Drive
            return false;
        }
    }
}

module.exports = new GoogleDriveService();
