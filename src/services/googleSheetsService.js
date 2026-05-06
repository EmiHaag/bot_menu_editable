const { google } = require('googleapis');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache

class GoogleSheetsService {
    constructor(config) {
        this.spreadsheetId = config.spreadsheetId;
        this.clientId = config.clientId; 
        this.range = config.range || 'Menu!A2:F'; // A:ID_client, B:ID, C:ParentID, D:Title, E:Message, F:Trigger
        
        let credentials;
        try {
            credentials = typeof config.credentials === 'string' 
                ? JSON.parse(config.credentials) 
                : config.credentials;
        } catch (e) {
            console.error('Error parsing credentials:', e.message);
            throw new Error('Invalid credentials provided to GoogleSheetsService');
        }

        this.auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    async getMenuData() {
        const cacheKey = `menu_data_${this.clientId}`;
        const cachedData = cache.get(cacheKey);
        if (cachedData) return cachedData;

        try {
            const sheets = google.sheets({ version: 'v4', auth: this.auth });
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: this.range,
            });

            const rows = response.data.values;
            if (!rows || rows.length === 0) {
                console.log('No data found in spreadsheet.');
                return [];
            }

            const allMenu = rows.map((row, index) => ({
                idClient: row[0] || '',
                id: row[1] || '',
                parentId: row[2] || '',
                title: row[3] || '',
                message: row[4] || '',
                trigger: row[5] || '',
                rowIndex: index + 2 
            }));

            // Filtramos por CLIENT_ID
            // Si el clientId es 'default', permitimos también nodos que no tengan ID_client asignado
            const filteredMenu = allMenu.filter(node => {
                const isDirectMatch = node.idClient === this.clientId;
                const isDefaultFallback = this.clientId === 'default' && (!node.idClient || node.idClient === '');
                return isDirectMatch || isDefaultFallback;
            });

            cache.set(cacheKey, filteredMenu);
            return filteredMenu;
        } catch (error) {
            console.error(`Error fetching Google Sheets data for client ${this.clientId}:`, error);
            return [];
        }
    }

    async getNodesByParent(parentId) {
        const menu = await this.getMenuData();
        return menu.filter(node => node.parentId === parentId);
    }

    async getNodeById(id) {
        const menu = await this.getMenuData();
        return menu.find(node => node.id === id);
    }

    clearCache() {
        cache.del(`menu_data_${this.clientId}`);
    }
}

module.exports = GoogleSheetsService;
