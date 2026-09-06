require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });
const express = require('C:/Users/emili/coding/bots_koyeb/bot_menu/node_modules/express');
const Dashboard = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/utils/dashboard.js');
const fs = require('fs');

const app = express();
app.use((req, res, next) => {
    req.user = { idCliente: 'test_farma', nombreCliente: 'Test', spreadsheetId: '' };
    next();
});
app.use('/', Dashboard.setupRoutes());

const server = app.listen(0, async () => {
    const port = server.address().port;
    try {
        const resp = await fetch(`http://localhost:${port}/?botId=test_farma`);
        const html = await resp.text();
        fs.writeFileSync('C:/Users/emili/AppData/Local/Temp/opencode/dashboard_render.html', html);
        console.log('Render OK', resp.status, html.length + ' chars');
    } catch (err) {
        console.error('RENDER FAIL:', err.message);
    } finally {
        server.close();
        process.exit(0);
    }
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);