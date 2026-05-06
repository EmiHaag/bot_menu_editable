require('dotenv').config();

const bots = [{
        id: process.env.CLIENT_ID || 'default',
        spreadsheetId: process.env.SPREADSHEET_ID,
        credentials: process.env.CREDENTIALS_JSON,
        authFolder: 'auth_info_baileys'
    },
    {
        id: 'cliente_ncr', // Nuevo ID para el segundo bot
        spreadsheetId: process.env.SPREADSHEET_ID, // Puede ser el mismo Sheet si usas ID_client
        credentials: process.env.CREDENTIALS_JSON, // Pueden ser las mismas credenciales si aplican
        authFolder: 'auth_info_cliente_ncr' // Carpeta ÚNICA para la sesión de WhatsApp de este bot
    }
];

module.exports = bots;