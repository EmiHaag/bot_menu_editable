require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });
const GoogleDriveService = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/googleDriveService');

(async () => {
    const drive = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/googleDriveService').drive;

    async function listAll(query, label) {
        const r = await drive.files.list({ q: query, fields: 'files(id,name,parents,mimeType)', pageSize: 100, spaces: 'drive', includeItemsFromAllDrives: false });
        console.log(`\n[${label}]`);
        for (const f of r.data.files || []) {
            console.log(`  ${f.id}  ${f.name}  parents=[${(f.parents||[]).join(',')}]  ${f.mimeType}`);
        }
        return r.data.files || [];
    }

    // Root folders
    await listAll("'root' in parents and trashed=false", 'ROOT');
    // Files named prueba_* (the upload test)
    await listAll("name contains 'prueba_' and trashed=false", 'prueba_ files');
    // All folders
    await listAll("mimeType='application/vnd.google-apps.folder' and trashed=false", 'ALL FOLDERS');
})();