require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { MenuDbService, sql } = require(ROOT + '/app/src/services/menuDbService');

async function assert(cond, msg) {
    if (!cond) { console.log('FAIL: ' + msg); process.exitCode = 1; }
    else console.log('OK: ' + msg);
}
const CID = '__test_adapter__';
(async () => {
    await sql`DELETE FROM menu_nodos WHERE comercio_id = ${CID}`;
    const svc = new MenuDbService({ clientId: CID });

    await svc.initializeClientSheet();
    let menu = await svc.getMenuData();
    await assert(menu.length === 1, 'init crea 1 root');

    await svc.addNode({ id: 'cat1', parentId: 'root', title: 'Categoria', message: 'elige', trigger: '1', price: 0, strictTrigger: 'true', redirigirA: '', disponible: 'true' });
    await svc.addNode({ id: 'pizza', parentId: 'cat1', title: 'Pizza', message: 'opciones', trigger: '1', price: '10499', strictTrigger: 'false', redirigirA: '', disponible: 'true' });
    await svc.updateNode(null, { id: 'pizza', parentId: 'cat1', title: 'Pizza XL', message: 'opciones2', trigger: '1', price: '11599,99', strictTrigger: 'true', redirigirA: '', disponible: 'false' });

    menu = await svc.getMenuData();
    await assert(menu.length === 3, '3 nodos tras adds');
    const cat = menu.find(n => n.id === 'cat1');
    const pizza = menu.find(n => n.id === 'pizza');
    await assert(cat && cat.parentId === 'root' && cat.strictTrigger === 'true', 'cat1 parent+strict correctos');
    await assert(pizza && pizza.title === 'Pizza XL', 'update cambia titulo');
    await assert(pizza && pizza.price === '11599.99', 'update price coma->punto: ' + pizza.price);
    await assert(pizza && pizza.disponible === 'false', 'update disponible false');

    const hijosCat = await svc.getNodesByParent('cat1');
    await assert(hijosCat.length === 1 && hijosCat[0].id === 'pizza', 'getNodesByParent ok');
    const nodo = await svc.getNodeById('pizza');
    await assert(nodo && nodo.id === 'pizza', 'getNodeById ok');

    const padres = menu.filter(n => n.parentId === 'root').length;
    await assert(padres === 1, 'solo cat1 en root');

    await svc.deleteNodeAndChildren('cat1');
    menu = await svc.getMenuData();
    await assert(menu.length === 1, 'delete cascada deja solo root');

    await svc.clearCache();
    await sql`DELETE FROM menu_nodos WHERE comercio_id = ${CID}`;
    console.log('DONE');
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
