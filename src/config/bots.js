require('dotenv').config();

const bots = [
    {
        id: process.env.CLIENT_ID || 'default',
        spreadsheetId: process.env.SPREADSHEET_ID,
        credentials: process.env.CREDENTIALS_JSON,
        authFolder: 'auth_info_baileys'
    }
];

module.exports = bots;
