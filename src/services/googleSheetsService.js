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

            const rows = response.data.values || [];
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
            let filteredMenu = allMenu.filter(node => {
                const isDirectMatch = String(node.idClient).trim() === String(this.clientId).trim();
                const isDefaultFallback = this.clientId === 'default' && (!node.idClient || node.idClient === '');
                return isDirectMatch || isDefaultFallback;
            });

            // Si no hay datos para este cliente y no es el default, inicializamos con un nodo root
            if (filteredMenu.length === 0 && this.clientId !== 'default' && this.clientId !== 'admin') {
                console.log(`[GoogleSheetsService] No hay datos para el cliente ${this.clientId}. Inicializando nodo root por defecto...`);
                await this.initializeClientSheet();
                // Limpiar caché y reintentar para obtener el nodo recién creado
                this.clearCache();
                return this.getMenuData();
            }

            cache.set(cacheKey, filteredMenu);
            return filteredMenu;
        } catch (error) {
            console.error(`Error fetching Google Sheets data for client ${this.clientId}:`, error);
            return [];
        }
    }

    async initializeClientSheet() {
        try {
            const sheets = google.sheets({ version: 'v4', auth: this.auth });
            const sheetName = this.range.split('!')[0];
            
            // Buscar la primera fila vacía en la columna A
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${sheetName}!A:A`,
            });
            const rows = response.data.values || [];
            let nextRow = rows.length + 1;

            // Asegurarse de no sobrescribir la cabecera si el sheet está vacío
            if (nextRow < 2) nextRow = 2;

            // Valores por defecto: id_cliente, id, parentID, Titulo, Mensaje, Trigger
            const defaultValues = [
                [this.clientId, 'root', '', 'Inicio', 'Hola bienvenido a .. ', '0']
            ];

            await sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `${sheetName}!A${nextRow}:F${nextRow}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: defaultValues
                }
            });
            
            console.log(`[GoogleSheetsService] Nodo root inicializado para cliente ${this.clientId} en fila ${nextRow}`);
        } catch (error) {
            console.error(`Error al inicializar el sheet para el cliente ${this.clientId}:`, error.message);
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

    async deleteNodeAndChildren(nodeId) {
        const menu = await this.getMenuData();
        const toDelete = new Set();

        const findChildren = (id) => {
            const children = menu.filter(node => node.parentId === id);
            children.forEach(child => {
                toDelete.add(child.rowIndex);
                findChildren(child.id);
            });
        };

        const targetNode = menu.find(node => node.id === nodeId);
        if (targetNode) {
            toDelete.add(targetNode.rowIndex);
            findChildren(nodeId);
        }

        if (toDelete.size > 0) {
            const sheets = google.sheets({ version: 'v4', auth: this.auth });
            const sheetName = this.range.split('!')[0];
            
            const promises = Array.from(toDelete).map(rowIndex => 
                sheets.spreadsheets.values.clear({
                    spreadsheetId: this.spreadsheetId,
                    range: `${sheetName}!A${rowIndex}:F${rowIndex}`,
                })
            );

            await Promise.all(promises);
            this.clearCache();
        }
    }

    clearCache() {
        cache.del(`menu_data_${this.clientId}`);
    }
}

module.exports = GoogleSheetsService;
