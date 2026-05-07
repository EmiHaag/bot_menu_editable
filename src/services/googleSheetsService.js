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

            console.log(`[GoogleSheetsService] Filtering data for clientId: "${this.clientId}"`);
            
            // Filtramos por CLIENT_ID
            const filteredMenu = allMenu.filter(node => {
                const isDirectMatch = String(node.idClient).trim() === String(this.clientId).trim();
                const isDefaultFallback = this.clientId === 'default' && (!node.idClient || node.idClient === '');
                
                if (isDirectMatch) console.log(`[GoogleSheetsService] Match found for node ID: ${node.id}`);
                
                return isDirectMatch || isDefaultFallback;
            });

            console.log(`[GoogleSheetsService] Found ${filteredMenu.length} matches out of ${allMenu.length} total rows.`);

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
