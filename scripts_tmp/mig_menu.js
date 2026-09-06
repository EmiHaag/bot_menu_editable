require('dotenv').config();
const { ensureMenuTables, sql } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/app/src/services/menuDbService');
(async () => {
    await ensureMenuTables();
    const t = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'menu_nodos'`;
    const i = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'menu_nodos'`;
    const b = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'nombre_negocio'`;
    console.log('tabla:', JSON.stringify(t));
    console.log('indices:', JSON.stringify(i));
    console.log('bots.nombre_negocio:', JSON.stringify(b));
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
