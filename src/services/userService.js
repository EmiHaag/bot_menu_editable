const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 600 }); // 10 minutes cache for users

class UserService {
    constructor() {
        this.spreadsheetId = process.env.SPREADSHEET_ID;
        this.range = 'Usuarios!A2:F'; // id_cliente, nombre_cliente, activo, user, password, fecha_suscripcion
        
        let credentials;
        try {
            credentials = typeof process.env.CREDENTIALS_JSON === 'string' 
                ? JSON.parse(process.env.CREDENTIALS_JSON) 
                : process.env.CREDENTIALS_JSON;
        } catch (e) {
            console.error('Error parsing credentials in UserService:', e.message);
            throw new Error('Invalid credentials provided to UserService');
        }

        this.auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
    }

    async getUsers() {
        const cachedUsers = cache.get('all_users');
        if (cachedUsers) return cachedUsers;

        try {
            const sheets = google.sheets({ version: 'v4', auth: this.auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: this.range,
            });

            const rows = response.data.values;
            if (!rows || rows.length === 0) {
                console.log('No users found in spreadsheet.');
                return [];
            }

            const users = rows.map(row => ({
                idCliente: row[0] || '',
                nombreCliente: row[1] || '',
                activo: String(row[2]).toUpperCase() === 'TRUE',
                user: row[3] || '',
                password: row[4] || '',
                fechaSuscripcion: row[5] || ''
            }));

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

    clearCache() {
        cache.del('all_users');
    }
}

module.exports = new UserService();
