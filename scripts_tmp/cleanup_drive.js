require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });
const GoogleDriveService = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/googleDriveService');

(async () => {
    const targetId = '16zGAv04wtAeddqEk5DPxFM_tY7csx0IE';
    const folderId = '1hFVmabgY0uxUqYwaQ97THQfMkccZ5Zkw';
    await GoogleDriveService.deleteFile(targetId);
    await GoogleDriveService.deleteFile(folderId);
    console.log('Artefactos de prueba eliminados (papelera).');
})();