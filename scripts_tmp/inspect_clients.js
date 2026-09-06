require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const userService = require(ROOT + '/app/src/services/userService');
(async () => {
    const users = await userService.getUsers();
    const clients = users.filter(u => u.idCliente !== 'admin' && u.activo);
    console.log('total users:', users.length, '| activos:', clients.length);
    for (const c of clients) {
        console.log(JSON.stringify({ idCliente: c.idCliente, nombre: c.nombreCliente, spreadsheet: c.spreadsheetId ? 'set' : 'none' }));
    }
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
