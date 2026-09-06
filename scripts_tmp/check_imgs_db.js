require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { sql } = require(ROOT + '/app/src/services/menuDbService');
(async () => {
    const r = await sql`SELECT comercio_id, node_id, titulo, imagenes FROM menu_nodos WHERE comercio_id='test_inmobiliaria' ORDER BY row_index`;
    for (const row of r) {
        console.log(row.node_id, '|', row.titulo, '| imagenes=', JSON.stringify(row.imagenes));
    }
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });