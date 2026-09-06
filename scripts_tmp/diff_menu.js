require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const userService = require(ROOT + '/app/src/services/userService');
const GoogleSheetsService = require(ROOT + '/app/src/services/googleSheetsService');
const { sql } = require(ROOT + '/app/src/services/menuDbService');
(async () => {
    const users = await userService.getUsers();
    const clientes = users.filter(u => u.idCliente !== 'admin' && u.activo);
    let totalDiff = 0;
    for (const c of clientes) {
        const sid = c.spreadsheetId || process.env.SPREADSHEET_ID;
        const svc = new GoogleSheetsService({ clientId: c.idCliente, spreadsheetId: sid });
        const sheets = await svc.getMenuData();
        const db = await sql`SELECT node_id, parent_node_id, titulo, trigger, precio, strict_trigger, redirigir_a, disponible FROM menu_nodos WHERE comercio_id = ${c.idCliente}`;
        const keysSheets = new Set(sheets.map(n => n.id));
        const keysDb = new Set(db.map(n => n.node_id));
        const soloSheets = [...keysSheets].filter(k => !keysDb.has(k));
        const soloDb = [...keysDb].filter(k => !keysSheets.has(k));
        let diffs = 0;
        for (const n of sheets) {
            const row = db.find(d => d.node_id === n.id);
            if (!row) continue;
            const bool = (v) => String(v).toLowerCase() === 'true';
            if ((row.titulo || '') !== (n.title || '')) diffs++;
            if ((row.parent_node_id || '') !== (n.parentId || '')) diffs++;
            if ((row.trigger || '') !== (n.trigger || '')) diffs++;
            if (!!row.strict_trigger !== bool(n.strictTrigger)) diffs++;
            if ((row.redirigir_a || '') !== (n.redirigirA || '')) diffs++;
            if (!!row.disponible !== (String(n.disponible).toLowerCase() !== 'false')) diffs++;
        }
        if (soloSheets.length || soloDb.length || diffs) {
            console.log(`${c.idCliente}: sheets=${keysSheets.size} db=${keysDb.size} soloSheets=${JSON.stringify(soloSheets)} soloDb=${JSON.stringify(soloDb)} diffs=${diffs}`);
            totalDiff += soloSheets.length + soloDb.length + diffs;
        } else {
            console.log(`${c.idCliente}: OK (${keysSheets.size})`);
        }
    }
    console.log('TOTAL diffs:', totalDiff);
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
