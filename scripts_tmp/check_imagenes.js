require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { ensureMenuTables, sql } = require(ROOT + '/app/src/services/menuDbService');
(async () => {
    await ensureMenuTables();
    const r = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'menu_nodos' AND column_name = 'imagenes'`;
    console.log('columna imagenes:', JSON.stringify(r));
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
