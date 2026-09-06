require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });
const express = require('C:/Users/emili/coding/bots_koyeb/bot_menu/node_modules/express');
const Dashboard = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/utils/dashboard.js');
const GoogleDriveService = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/googleDriveService');
const fs = require('fs');

(async () => {
    // 1. Subir una imagen real (para poder borrarla luego via endpoint)
    const { optimizarImagen } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/imageOptimizerService');
    const probe = fs.readFileSync('C:/Users/emili/AppData/Local/Temp/opencode/test_img.jpg');
    const opt = await optimizarImagen(probe);
    const folder = await GoogleDriveService.getOrCreateImagesFolder('test_inmobiliaria');
    const up = await GoogleDriveService.uploadFile(opt, {
        filename: `borrar_test_${Date.now()}.jpg`,
        mimeType: 'image/jpeg',
        parentFolderId: folder
    });
    console.log('Subida nueva:', up.fileId);

    // 2. Crear server mock
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { idCliente: 'test_inmobiliaria', nombreCliente: 'Test', spreadsheetId: '' };
        next();
    });
    app.use('/', Dashboard.setupRoutes());

    const server = app.listen(0, async () => {
        const port = server.address().port;
        try {
            const resp = await fetch(`http://localhost:${port}/api/borrar-imagen`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ driveFileId: up.fileId, botId: 'test_inmobiliaria' })
            });
            const data = await resp.json();
            console.log('Endpoint borrar-imagen:', resp.status, JSON.stringify(data));

            // 3. Verificar que ya no existe en Drive
            let existe = true;
            try {
                await GoogleDriveService.drive.files.get({ fileId: up.fileId });
            } catch (e) {
                existe = false;
            }
            console.log('Existe en Drive después del borrado:', existe);
            console.log(existe ? '\nFALLO: no se borró' : '\nTODO OK');
        } catch (err) {
            console.error('ERROR:', err.message);
        } finally {
            server.close();
            process.exit(0);
        }
    });
})();
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);