const { google } = require('googleapis');
const NodeCache = require('node-cache');
const GoogleAuthBase = require('./googleAuthBase');

const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes cache for users

class UserService extends GoogleAuthBase {
    constructor() {
        super();
        this.spreadsheetId = process.env.SPREADSHEET_ID;
        this.range = 'Usuarios!A2:G'; // id_cliente, nombre_cliente, activo, user, password, fecha_suscripcion, spreadsheetId
    }

    get sheets() {
        return google.sheets({ version: 'v4', auth: this.getAuthClient() });
    }

    async getUsers() {
        const cachedUsers = cache.get('all_users');
        if (cachedUsers) return cachedUsers;

        try {
            const sheets = this.sheets;
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: this.range,
            });

            const rows = response.data.values;
            const users = [];

            // Agregar usuario admin desde variables de entorno
            if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
                users.push({
                    idCliente: 'admin',
                    nombreCliente: 'Administrador',
                    activo: true,
                    user: process.env.ADMIN_USER,
                    password: process.env.ADMIN_PASS,
                    fechaSuscripcion: '-',
                    spreadsheetId: this.spreadsheetId
                });
            }

            if (rows && rows.length > 0) {
                rows.forEach(row => {
                    // Solo agregar si idCliente no está vacío
                    if (row[0] && row[0].trim() !== '') {
                        users.push({
                            idCliente: row[0].trim(),
                            nombreCliente: row[1] || '',
                            activo: String(row[2]).toUpperCase() === 'TRUE',
                            user: row[3] || '',
                            password: row[4] || '',
                            fechaSuscripcion: row[5] || '',
                            spreadsheetId: row[6] || process.env.SPREADSHEET_ID
                        });
                    }
                });
            }

            cache.set('all_users', users);
            return users;
        } catch (error) {
            console.error('Error fetching users from Google Sheets:', error);
            return [];
        }
    }

    async getUserByUsername(username) {
        const users = await this.getUsers();
        return users.find(u => u.user === username);
    }

    async getActiveClients() {
        const users = await this.getUsers();
        return users.filter(u => u.activo && u.idCliente !== 'admin');
    }

    async addUser(userData) {
        try {
            const sheets = this.sheets;
            const { idCliente, nombreCliente, user, password, spreadsheetId } = userData;
            const fecha = new Date().toLocaleDateString();
            
            await sheets.spreadsheets.values.append({
                spreadsheetId: this.spreadsheetId,
                range: 'Usuarios!A2:G',
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[idCliente, nombreCliente, 'TRUE', user, password, fecha, spreadsheetId]]
                }
            });
            this.clearCache();
            return true;
        } catch (error) {
            console.error('Error adding user:', error);
            throw error;
        }
    }

    async deleteUser(idCliente) {
        try {
            const sheets = this.sheets;
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: 'Usuarios!A:A',
            });

            const rows = response.data.values || [];
            const rowIndex = rows.findIndex(row => row[0] === idCliente);

            if (rowIndex !== -1) {
                // Obtener el ID de la hoja 'Usuarios' para el borrado físico
                const spreadsheet = await sheets.spreadsheets.get({
                    spreadsheetId: this.spreadsheetId
                });
                const sheet = spreadsheet.data.sheets.find(s => s.properties.title === 'Usuarios');
                const sheetId = sheet ? sheet.properties.sheetId : 0;

                // Borrar la fila físicamente
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: this.spreadsheetId,
                    requestBody: {
                        requests: [
                            {
                                deleteDimension: {
                                    range: {
                                        sheetId: sheetId,
                                        dimension: 'ROWS',
                                        startIndex: rowIndex,
                                        endIndex: rowIndex + 1
                                    }
                                }
                            }
                        ]
                    }
                });

                this.clearCache();
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error deleting user:', error);
            throw error;
        }
    }

    clearCache() {
        cache.del('all_users');
    }
}

module.exports = new UserService();
