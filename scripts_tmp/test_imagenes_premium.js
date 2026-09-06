/**
 * Verificación de la feature de imágenes premium.
 * 1. optimizarImagen() reduce a <300KB y ancho <=1280
 * 2. verificarPlanPremium() distingue premium/estándar/trial
 * 3. Upload real a Drive (con filtro --upload para no disparar por defecto)
 */
require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });

const path = require('path');

async function testOptimizacion() {
    console.log('\n=== 1. optimizarImagen ===');
    const { optimizarImagen, MAX_WIDTH, MAX_SIZE_BYTES } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/imageOptimizerService');
    const fs = require('fs');

    // Imagen de prueba generada en proceso aparte (evita doble carga de libvips)
    const probePath = 'C:/Users/emili/AppData/Local/Temp/opencode/test_img.jpg';
    const bufferGrande = fs.readFileSync(probePath);

    console.log(`Imagen original: ${bufferGrande.length} bytes (${(bufferGrande.length / 1024).toFixed(0)} KB), 3200x2400`);
    const salida = await optimizarImagen(bufferGrande);
    const sharp = require('C:/Users/emili/coding/bots_koyeb/bot_menu/node_modules/sharp');
    const meta = await sharp(salida).metadata();
    console.log(`Optimizada: ${salida.length} bytes (${(salida.length / 1024).toFixed(1)} KB), ${meta.width}x${meta.height}`);

    if (meta.width > MAX_WIDTH) throw new Error(`Ancho ${meta.width} supera ${MAX_WIDTH}`);
    if (salida.length > MAX_SIZE_BYTES) throw new Error(`Tamaño ${salida.length} supera ${MAX_SIZE_BYTES}`);
    console.log('PASS: reducción <=1280px y <300KB');
}

async function testPremium() {
    console.log('\n=== 2. verificarPlanPremium ===');
    const { verificarPlanPremium } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/planService');
    const userService = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/userService');

    const users = await userService.getUsers();
    let premiumClients = 0;
    for (const u of users) {
        if (u.idCliente === 'admin') continue;
        const esperado = u.plan === 'premium' && u.activo === true;
        const resultado = await verificarPlanPremium(u.idCliente);
        const ok = esperado === resultado ? 'OK' : 'DIFERENTE';
        console.log(`  ${ok} ${u.idCliente.padEnd(18)} plan=${String(u.plan).padEnd(9)} activo=${String(u.activo).padEnd(5)} premium=${resultado}`);
        if (ok === 'DIFERENTE') throw new Error(`verificarPlanPremium incorrecto para ${u.idCliente}`);
        if (resultado) premiumClients++;
    }
    console.log(`PASS: verificación coincide en todos los clientes (${premiumClients} premium activo)`);
    if (premiumClients === 0) console.log('NOTA: ningún cliente premium activo; el gate 403 echará todo upload.');
}

async function testUpload() {
    console.log('\n=== 3. Upload real a Drive ===');
    if (!process.argv.includes('--upload')) {
        console.log('SKIP: usar --upload para subir una imagen de prueba real a Drive.');
        return;
    }
    const GoogleDriveService = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/googleDriveService');
    const { optimizarImagen } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/imageOptimizerService');

    const cliente = process.env.TEST_CLEINT || 'test_inmobiliaria';
    const folderId = await GoogleDriveService.getOrCreateImagesFolder(cliente);
    console.log(`Folder para ${cliente}: ${folderId}`);
    const fs = require('fs');
    const probePath = 'C:/Users/emili/AppData/Local/Temp/opencode/test_img.jpg';
    const bufferGrande = fs.readFileSync(probePath);
    const optimizada = await optimizarImagen(bufferGrande);
    const subida = await GoogleDriveService.uploadFile(optimizada, {
        filename: `prueba_${Date.now()}.jpg`,
        mimeType: 'image/jpeg',
        parentFolderId: folderId
    });
    console.log(`Subida OK: fileId=${subida.fileId} size=${subida.size} url=${subida.url}`);
    console.log('Verificá en el navegador que la URL sea accesible públicamente.');
}

(async () => {
    try {
        await testOptimizacion();
        await testPremium();
        await testUpload();
        console.log('\nTODO OK');
    } catch (err) {
        console.error('\nFALLO:', err.message);
        process.exit(1);
    }
})();