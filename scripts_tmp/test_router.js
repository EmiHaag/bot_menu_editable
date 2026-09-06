require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const IntentRouterService = require(ROOT + '/app/src/services/intentRouterService');

const catRoot = [
    { trigger: '1', title: 'Alquileres', price: 0, seccion: true },
    { trigger: '2', title: 'Ventas', price: 0, seccion: true }
];

(async () => {
    const router = new IntentRouterService({
        idCliente: 'test_inmobiliaria',
        buildCatalogo: async () => catRoot,
        buildContexto: async () => 'NODO ACTUAL DEL USUARIO: root\n(el cliente todavía no tiene ítems en el pedido)',
        ai: { estilo: 'cercano' },
        negocio: 'Inmobiliaria Rodriguez'
    });

    const msgs = ['hola quiero alquilar', 'hola, quiero alquilar una casa', 'quiero ver los departamentos'];
    for (const m of msgs) {
        const cls = await router.clasificar('test+549', m);
        console.log('MSG:', m);
        console.log('  ->', JSON.stringify(cls));
    }
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 30000);