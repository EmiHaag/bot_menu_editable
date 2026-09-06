require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { sql } = require(ROOT + '/app/src/services/menuDbService');
(async () => {
    const r = await sql`SELECT node_id, parent_node_id, titulo, trigger, precio, disponible, strict_trigger, redirigir_a FROM menu_nodos WHERE comercio_id='test_inmobiliaria' ORDER BY row_index`;
    console.table(r);
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
