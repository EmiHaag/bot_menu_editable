require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { MenuDbService } = require(ROOT + '/app/src/services/menuDbService');
(async () => {
    const svc = new MenuDbService({ clientId: 'test_inmobiliaria' });
    const all = await svc.getMenuData();
    for (const n of all) {
        console.log(JSON.stringify({ id: n.id, parent: n.parentId, title: n.title, trigger: n.trigger, price: n.price, strict: n.strictTrigger, redirigirA: n.redirigirA, disponible: n.disponible, message: (n.message || '').slice(0, 120) }));
    }
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });