require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });
const fs = require('fs');

(async () => {
    const { MenuDbService, ensureMenuTables } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/menuDbService');
    const GoogleDriveService = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/googleDriveService');
    const { optimizarImagen } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/imageOptimizerService');

    const clientId = process.env.TEST_CLIENT || 'test_inmobiliaria';
    const svc = new MenuDbService({ clientId });

    // 1. Subir 2 imágenes de prueba a Drive
    const probe = fs.readFileSync('C:/Users/emili/AppData/Local/Temp/opencode/test_img.jpg');
    const opt = await optimizarImagen(probe);
    const folder = await GoogleDriveService.getOrCreateImagesFolder(clientId);
    let ids = [];
    for (let i = 0; i < 2; i++) {
        const up = await GoogleDriveService.uploadFile(opt, {
            filename: `cleanup_test_${Date.now()}_${i}.jpg`,
            mimeType: 'image/jpeg',
            parentFolderId: folder
        });
        ids.push(up);
        console.log(`Subida ${i}: ${up.fileId} -> ${up.url}`);
    }

    // 2. Crear nodo temporal vinculado a las 2 imágenes
    const nodeId = 'cleanup_test_' + Date.now();
    await svc.addNode({
        id: nodeId,
        parentId: 'root',
        trigger: '999',
        title: 'Nodo cleanup test',
        message: 'test',
        price: '',
        redirigirA: '',
        disponible: 'true',
        imagenes: ids.map(u => ({ url: u.url, driveFileId: u.fileId }))
    });

    // 3. Actualizar el nodo quitando la 2da imagen (simula botón ✕ + guardar)
    await svc.updateNode(null, {
        id: nodeId,
        parentId: 'root',
        trigger: '999',
        title: 'Nodo cleanup test',
        message: 'test',
        price: '',
        redirigirA: '',
        disponible: 'true',
        imagenes: [{ url: ids[0].url, driveFileId: ids[0].fileId }]
    });

    // 4. Verificar en BD solo queda 1 imagen
    const nodo = await svc.getNodeById(nodeId);
    console.log('Imágenes restantes en BD:', nodo && nodo.imagenes ? nodo.imagenes.length : 'NO NODE');

    // 5. Verificar que el archivo removido ya no existe en Drive
    let removedGone = false;
    try {
        await GoogleDriveService.drive.files.get({ fileId: ids[1].fileId });
    } catch (e) {
        if (e && (e.code === 404 || (e.message || '').includes('Not Found'))) removedGone = true;
    }
    console.log('Imagen removida ya no existe en Drive:', removedGone);

    // 6. Limpiar: borrar nodo y la imagen restante
    await svc.deleteNodeAndChildren(nodeId);
    await GoogleDriveService.deleteFile(ids[0].fileId);

    const restanteGone = await (async () => {
        try {
            await GoogleDriveService.drive.files.get({ fileId: ids[0].fileId });
            return false;
        } catch (e) {
            return true;
        }
    })();
    console.log('Nodo borrado + imagen restante eliminada:', restanteGone);

    if (nodo && nodo.imagenes && nodo.imagenes.length === 1 && removedGone && restanteGone) {
        console.log('\nTODO OK');
    } else {
        console.log('\nFALLO en verificación de limpieza');
        process.exit(1);
    }
})();