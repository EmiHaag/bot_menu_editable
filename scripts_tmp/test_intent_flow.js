require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';

const { MenuDbService } = require(ROOT + '/app/src/services/menuDbService');
const AIUsageService = require(ROOT + '/app/src/services/aiUsageService');
const UserService = require(ROOT + '/app/src/services/userService');
const BotConfigService = require(ROOT + '/app/src/services/botConfigService');
const AITranslatorController = require(ROOT + '/app/src/controllers/aiTranslatorController');

// Mocks minimos de StateService que el traductor usa
const sessionMap = new Map();
const stateMap = new Map();
const userIntentMap = new Map();
const failsMap = new Map();

const stateService = {
    clientId: 'test_inmobiliaria',
    getUserState: (jid) => stateMap.get(jid) || 'root',
    setUserState: (jid, v) => stateMap.set(jid, v),
    getChatSession: (jid) => sessionMap.get(jid) || { history: [], nodeId: 'root' },
    setChatSession: (jid, v) => sessionMap.set(jid, v),
    getUserOrder: () => [],
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
};

// Mock necesario para _opcionesNivel / _tipoPaso
// AITranslatorController usa this.googleSheetsService.getNodesByParent/getNodeById
const sheetsMock = {
    getNodesByParent: (p) => new MenuDbService({ clientId: 'test_inmobiliaria' }).getNodesByParent(p),
    getNodeById: (id) => new MenuDbService({ clientId: 'test_inmobiliaria' }).getNodeById(id),
};

const menuController = {
    sendMenu: async (sock, jid, nodeId) => { console.log('  [sendMenu] nivel:', nodeId); },
    addItemDirect: async () => true,
    removeItemDirect: async () => true,
};

const mensajesEnviados = [];
const sock = {
    sendMessage: async (jid, m) => { mensajesEnviados.push(m.text || m.image || ''); console.log('  [sock.send]', JSON.stringify(m).slice(0, 160)); },
    presenceComposing: async () => {},
    sendPresenceComposing: async () => {},
    presenceUpdate: async () => {},
};

(async () => {
    const svc = new MenuDbService({ clientId: 'test_inmobiliaria' });

    const translator = new AITranslatorController({
        idCliente: 'test_inmobiliaria',
        googleSheetsService: sheetsMock,
        stateService,
        orderService: null,
        menuController
    });

    // Necesitamos que _sendFriendly funcione. El traductor usa _sendFriendly -> sock.sendMessage probablemente
    // localhost: solo usamos paths que no dependan de _buildPrompt.

const cases = [
        { msg: 'hola quiero alquilar', expect: '1' },
        { msg: 'hola, quiero alquilar una casa', expect: '1' },
        { msg: 'quiero ver los departamentos', expect: '1' },
        { msg: 'no tenes mas opciones?', expect: { derivado: true } },
    ];

    for (const c of cases) {
        sessionMap.clear(); stateMap.clear(); failsMap.clear(); mensajesEnviados.length = 0;
        const res = await translator.handleMessage(sock, '54911+TEST', c.msg, { pushName: 'Cliente' });
        console.log(`CASO "${c.msg}"`);
        console.log('  RESULTADO:', JSON.stringify(res));
        const primerMsg = mensajesEnviados[0] || '';
        console.log('  SALUDO enviado:', primerMsg.includes('bienvenido') ? 'SÍ' : 'NO', JSON.stringify(primerMsg).slice(0, 100));
        if (typeof res === 'string' && res === c.expect) {
            console.log('  OK ✓');
        } else if (typeof c.expect === 'object' && JSON.stringify(res) === JSON.stringify(c.expect)) {
            console.log('  OK ✓');
        } else {
            console.log(`  ✗ ESPERADO "${JSON.stringify(c.expect)}"`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 60000);