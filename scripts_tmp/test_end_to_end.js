require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { MenuDbService } = require(ROOT + '/app/src/services/menuDbService');
const MenuController = require(ROOT + '/app/src/controllers/menuController');
const AITranslatorController = require(ROOT + '/app/src/controllers/aiTranslatorController');

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

const svc = new MenuDbService({ clientId: 'test_inmobiliaria' });
const sheetsMock = {
    getNodesByParent: (p) => svc.getNodesByParent(p),
    getNodeById: (id) => svc.getNodeById(id),
};

const controller = new MenuController(sheetsMock, stateService, null);

const mensajes = [];
const sock = {
    sendMessage: async (jid, m) => { mensajes.push(m.text || m.image || ''); },
    sendPresenceUpdate: async () => {},
    sendPresenceComposing: async () => {},
    presenceComposing: async () => {},
    sendPresenceComposing: async () => {},
};

// Simular app.js: traduccion -> si string -> handleIncomingMessage
(async () => {
    const translator = new AITranslatorController({
        idCliente: 'test_inmobiliaria',
        googleSheetsService: sheetsMock,
        stateService,
        orderService: null,
        menuController: controller
    });

    const jid = '54911+TEST';
    const msg = 'hola ando buscando casa para alquilar que opciones tenes ?';
    const traduccion = await translator.handleMessage(sock, jid, msg, { pushName: 'Cliente' });
    console.log('TRADUCCION:', JSON.stringify(traduccion));
    if (typeof traduccion === 'string') {
        await controller.handleIncomingMessage(sock, jid, traduccion);
    }
    console.log('\n===== RESPUESTA EN WHATSAPP =====\n');
    mensajes.forEach((m, i) => console.log(`[msg ${i + 1}]\n${m}\n---`));
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 60000);