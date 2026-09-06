require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { sql } = require(ROOT + '/app/src/services/menuDbService');
(async () => {
    const r = await sql`SELECT comercio_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE node_id = 'root') AS roots FROM menu_nodos GROUP BY comercio_id ORDER BY comercio_id`;
    console.table(r);
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
