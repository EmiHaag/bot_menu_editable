const { google } = require('googleapis');
const NodeCache = require('node-cache');
const GoogleAuthBase = require('./googleAuthBase');

const cache = new NodeCache({ stdTTL: 300 }); // 5 minutes cache

class GoogleSheetsService extends GoogleAuthBase {
    constructor(config) {
        super();
        this.spreadsheetId = config.spreadsheetId;
        this.clientId = config.clientId; 
        this.range = config.range || 'Menu!A2:H'; // A:ID_client, B:ID, C:ParentID, D:Title, E:Message, F:Trigger, G:Price, H:StrictTrigger
    }

    get sheets() {
        return google.sheets({ version: 'v4', auth: this.getAuthClient() });
    }

    async getMenuData() {
        const cacheKey = `menu_data_${this.clientId}`;
        const cachedData = cache.get(cacheKey);
        if (cachedData) return cachedData;

        try {
            const sheets = this.sheets;
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
                price: row[6] || '',
                strictTrigger: String(row[7] || 'false').toLowerCase(),
                rowIndex: index + 2 
            }));

            // Filtramos por CLIENT_ID y aseguramos que el nodo tenga al menos un ID
            let filteredMenu = allMenu.filter(node => {
                const hasId = node.id && node.id.trim() !== '';
                const isDirectMatch = String(node.idClient).trim() === String(this.clientId).trim();
                const isDefaultFallback = this.clientId === 'default' && (!node.idClient || node.idClient === '');
                
                return hasId && (isDirectMatch || isDefaultFallback);
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
            const sheets = this.sheets;
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

            // Valores por defecto: id_cliente, id, parentID, Titulo, Mensaje, Trigger, Precio, StrictTrigger
            const defaultValues = [
                [this.clientId, 'root', '', 'Inicio', 'Hola bienvenido a .. ', '0', '', 'false']
            ];

            await sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `${sheetName}!A${nextRow}:H${nextRow}`,
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
        console.log(`[Sheets] Intentando borrar nodo y sus hijos: ${nodeId}`);
        const menu = await this.getMenuData();
        const toDelete = new Set();

        const findChildren = (id) => {
            const children = menu.filter(node => node.parentId === id);
            children.forEach(child => {
                console.log(`[Sheets] Marcando hijo para borrar: ${child.id} (Fila ${child.rowIndex})`);
                toDelete.add(child.rowIndex);
                findChildren(child.id);
            });
        };

        const targetNode = menu.find(node => node.id === nodeId);
        if (targetNode) {
            console.log(`[Sheets] Nodo objetivo encontrado: ${nodeId} (Fila ${targetNode.rowIndex})`);
            toDelete.add(targetNode.rowIndex);
            findChildren(nodeId);
        } else {
            console.warn(`[Sheets] Nodo no encontrado: ${nodeId}`);
        }

        if (toDelete.size > 0) {
            console.log(`[Sheets] Borrando ${toDelete.size} filas en Sheets...`);
            const sheets = this.sheets;
            const sheetName = this.range.split('!')[0];

            const promises = Array.from(toDelete).map(rowIndex => {
                console.log(`[Sheets] Limpiando fila: ${sheetName}!A${rowIndex}:H${rowIndex}`);
                return sheets.spreadsheets.values.clear({
                    spreadsheetId: this.spreadsheetId,
                    range: `${sheetName}!A${rowIndex}:H${rowIndex}`,
                });
            });

            await Promise.all(promises);
            console.log(`[Sheets] Borrado completado con éxito.`);
            this.clearCache();
        } else {
            console.log(`[Sheets] Nada que borrar.`);
        }
    }

    async updateNode(index, nodeData) {
        try {
            const sheets = this.sheets;
            const sheetName = this.range.split('!')[0];
            const { id, parentId, title, message, trigger, price, strictTrigger } = nodeData;

            await sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `${sheetName}!A${index}:H${index}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [
                        [this.clientId, id || '', parentId || '', title || '', message || '', trigger || '', price || '', strictTrigger || 'false']
                    ]
                }
            });
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[GoogleSheetsService] Error in updateNode:', error);
            throw error;
        }
    }

    async addNode(nodeData) {
        try {
            const sheets = this.sheets;
            const sheetName = this.range.split('!')[0];
            const { id, parentId, title, message, trigger, price } = nodeData;

            if (id === parentId && id !== 'root') {
                throw new Error('Un nodo no puede ser su propio padre.');
            }

            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: `${sheetName}!A:A`,
            });

            const rows = response.data.values || [];
            let nextRow = rows.length + 1;

            // Buscar huecos en las filas
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
                spreadsheetId: this.spreadsheetId,
                range: `${sheetName}!A${nextRow}:H${nextRow}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [
                        [this.clientId, id || '', parentId || '', title || '', message || '', trigger || '', price || '', 'false']
                    ]
                }
            });

            this.clearCache();
            return true;
        } catch (error) {
            console.error('[GoogleSheetsService] Error in addNode:', error);
            throw error;
        }
    }

    async deleteRow(index) {
        try {
            const sheets = this.sheets;
            const sheetName = this.range.split('!')[0];
            await sheets.spreadsheets.values.clear({
                spreadsheetId: this.spreadsheetId,
                range: `${sheetName}!A${index}:H${index}`,
            });
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[GoogleSheetsService] Error in deleteRow:', error);
            throw error;
        }
    }

    clearCache() {
        cache.del(`menu_data_${this.clientId}`);
    }
}

module.exports = GoogleSheetsService;
