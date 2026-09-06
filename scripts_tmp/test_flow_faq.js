require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';

const { MenuDbService } = require(ROOT + '/app/src/services/menuDbService');
const AITranslatorController = require(ROOT + '/app/src/controllers/aiTranslatorController');
const AIUsageService = require(ROOT + '/app/src/services/aiUsageService');
const UserService = require(ROOT + '/app/src/services/userService');
const BotConfigService = require(ROOT + '/app/src/services/botConfigService');

const sessionMap = new Map();
const stateMap = new Map();
const userIntentMap = new Map();
const failsMap = new Map();
const carritoOps = [];

const stateService = {
    clientId: 'test_inmobiliaria',
    getUserState: (jid) => stateMap.get(jid) || 'root',
    setUserState: (jid, v) => stateMap.set(jid, v),
    getChatSession: (jid) => sessionMap.get(jid) || { history: [], nodeId: 'root' },
    setChatSession: (jid, v) => sessionMap.set(jid, v),
    getUserOrder: () => [],
    setUserOrder: () => {},
    setUserIntent: (jid, v) => userIntentMap.set(jid, v),
    getUserIntent: (jid) => userIntentMap.get(jid) || null,
    clearUserIntent: (jid) => userIntentMap.delete(jid),
    setPendingOrderItems: () => {},
    getPendingOrderItems: () => [],
    clearPendingOrderItems: () => {},
    incrementTranslationFails: (jid) => { const n = (failsMap.get(jid) || 0) + 1; failsMap.set(jid, n); return n; },
    getTranslationFails: (jid) => failsMap.get(jid) || 0,
    clearTranslationFails: (jid) => failsMap.delete(jid),
    getPedidoFinalizado: () => false,
    getWaitingForData: () => null,
    getWaitingForFile: () => null,
    getPendingQuantityItem: () => null,
    getWaitingTurnoDate: () => null,
    getWaitingTurnoSlot: () => null,
    getWaitingTurnoConfirm: () => null,
    getWaitingTurnoReminder: () => null,
    getWaitingTurnoCascada: () => null,
    getWaitingTurnoWaitlistName: () => null,
    getMisTurnos: () => null,
    getMisTurnoSeleccionado: () => null,
    getWaitingTurnoReprogram: () => null,
    getChatSessionEstado: () => {},
    getDatosText: () => '',
    getDatos: () => '',
};

const dbsvc = new MenuDbService({ clientId: 'test_inmobiliaria' });
const sheetsMock = {
    getNodesByParent: (p) => dbsvc.getNodesByParent(p),
    getNodeById: (id) => dbsvc.getNodeById(id),
};

const menuController = {
    sendMenu: async (sock, jid, nodeId) => { console.log('  [sendMenu] nivel:', nodeId); },
    addItemDirect: async () => { carritoOps.push('addItemDirect'); return true; },
    removeItemDirect: async () => { carritoOps.push('removeItemDirect'); return true; },
};

const mensajesEnviados = [];
const sock = {
    sendMessage: async (jid, m) => { mensajesEnviados.push(m); console.log('  [sock.send]', (m.text || m.image || '').toString().slice(0, 140)); },
    presenceComposing: async () => {},
    sendPresenceComposing: async () => {},
    presenceUpdate: async () => {},
    sendPresenceUpdate: async () => {},
};

(async () => {
    const cfg = await BotConfigService.getBotConfig('test_inmobiliaria');
    console.log('BOT_TYPE real:', cfg.bot_type || 'CARRITO');

    const translator = new AITranslatorController({
        idCliente: 'test_inmobiliaria',
        googleSheetsService: sheetsMock,
        stateService,
        orderService: null,
        menuController
    });

    const cases = [
        { msg: 'quiero la casa de 3 habitaciones', expectFicha: true, expectNoCarrito: true },
        { msg: 'no tenes mas opciones?', expectFicha: false, expectNoCarrito: true },
    ];

    // Escenario "me interesa" tras ver la ficha de Casa (con interés guardado en sesión)
    {
        sessionMap.clear(); stateMap.clear(); failsMap.clear(); mensajesEnviados.length = 0; carritoOps.length = 0;
        stateMap.set('JIDINT', 'menu_opcion1');
        sessionMap.set('JIDINT', {
            history: [{ role: 'assistant', content: 'ficha vista' }],
            nodeId: 'menu_opcion1',
            interes: { trigger: '1', title: 'Casa 3 habitaciones Rodríguez al 2200' }
        });
        const res = await translator.handleMessage(sock, 'JIDINT', 'me interesa', { pushName: 'Cliente' });
        console.log('\nCASO "me interesa" (tras ver ficha de la Casa)');
        console.log('  RESULTADO:', JSON.stringify(res));
        console.log('  operaciones de carrito:', carritoOps.length === 0 ? 'NINGUNA (OK ✓)' : JSON.stringify(carritoOps) + ' ✗');
        const enviadosAlCliente = mensajesEnviados.filter(m => m.text && !String(m.text).includes('derivado -'));
        const avisoVendedor = mensajesEnviados.filter(m => m.text && String(m.text).includes('derivado -'));
        console.log('  mensajes al cliente:', enviadosAlCliente.map(m => m.text.slice(0, 110)).join(' | ') || '(sin texto directo, ver log)');
        const avisoOk = avisoVendedor.some(m => m.text.includes('Casa 3 habitaciones'));
        console.log('  aviso al vendedor con la propiedad:', avisoOk ? 'OK ✓' : '✗');
        const resDeriva = res && res.derivado === true;
        if (!resDeriva) { console.log('  ✗ no se derivó'); process.exitCode = 1; }
        if (!avisoOk) { console.log('  ✗ aviso al vendedor sin la propiedad'); process.exitCode = 1; }
        console.log(resDeriva && avisoOk ? '  OK ✓ interés deíctico -> derivación a vendedor' : '');
    }

    // Bug real: el estado ya estaba DENTRO de la ficha (nodo hoja, sin hijos en el
    // nivel actual). Antes, el bloque deíctico se salteaba (esOpcionInteres=false)
    // y "me interesa" caía al clasificador LLM reabriendo la ficha en vez de derivar.
    {
        sessionMap.clear(); stateMap.clear(); failsMap.clear(); mensajesEnviados.length = 0; carritoOps.length = 0;
        stateMap.set('JIDDEP', 'menu_opcion2_opcion1');
        sessionMap.set('JIDDEP', {
            history: [{ role: 'assistant', content: 'ficha vista' }],
            nodeId: 'menu_opcion2_opcion1',
            interes: { trigger: '1', title: 'Departamento Clásico 4 Ambientes, Impeca' }
        });
        const res = await translator.handleMessage(sock, 'JIDDEP', 'me interesa', { pushName: 'Cliente' });
        console.log('\nCASO "me interesa" (estado ya dentro de la ficha depto venta)');
        console.log('  RESULTADO:', JSON.stringify(res));
        console.log('  operaciones de carrito:', carritoOps.length === 0 ? 'NINGUNA (OK ✓)' : JSON.stringify(carritoOps) + ' ✗');
        const enviadosAlCliente = mensajesEnviados.filter(m => m.text && !String(m.text).includes('derivado -'));
        const avisoVendedor = mensajesEnviados.filter(m => m.text && String(m.text).includes('derivado -'));
        const avisoOk = avisoVendedor.some(m => m.text.includes('Departamento'));
        console.log('  aviso al vendedor con la propiedad:', avisoOk ? 'OK ✓' : '✗');
        const resDeriva2 = res && res.derivado === true;
        if (!resDeriva2) { console.log('  ✗ no se derivó (regresión del bug de ficha)'); process.exitCode = 1; }
        if (!avisoOk) { console.log('  ✗ aviso al vendedor sin la propiedad'); process.exitCode = 1; }
        console.log('  mensajes al cliente:', enviadosAlCliente.map(m => m.text.slice(0, 110)).join(' | ') || '(sin texto directo)');
        console.log(resDeriva2 && avisoOk ? '  OK ✓ interés deíctico en ficha -> derivación a vendedor' : '');
    }

    for (const c of cases) {
        sessionMap.clear(); stateMap.clear(); failsMap.clear(); mensajesEnviados.length = 0; carritoOps.length = 0;
        const res = await translator.handleMessage(sock, '54911+TESTFA', c.msg, { pushName: 'Cliente' });
        console.log(`\nCASO "${c.msg}"`);
        console.log('  RESULTADO:', JSON.stringify(res));
        console.log('  operaciones de carrito:', carritoOps.length === 0 ? 'NINGUNA (OK ✓)' : JSON.stringify(carritoOps) + ' ✗');
        const msgs = mensajesEnviados.map(m => {
            if (m.image) return 'IMAGEN';
            if (typeof m.text === 'string') return m.text.replace(/\n+/g, ' ').slice(0, 120);
            return '';
        });
        console.log('  salidas:', msgs.join(' | '));
        const soyTexto = msgs.some(t => t && (t.includes('Añadido') || t.includes('Total:') || t.includes('Tu pedido')));
        if (soyTexto) console.log('  ✗ TEXTO DE CARRITO ENCONTRADO');
        if (c.expectNoCarrito && (carritoOps.length > 0 || soyTexto)) process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 90000);