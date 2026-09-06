require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { MenuDbService } = require(ROOT + '/app/src/services/menuDbService');
const MenuController = require(ROOT + '/app/src/controllers/menuController');

const stateMap = new Map();
const sessionMap = new Map();
const stateService = {
    clientId: 'test_inmobiliaria',
    getUserState: (jid) => stateMap.get(jid) || 'root',
    setUserState: (jid, v) => stateMap.set(jid, v),
    getChatSession: (jid) => sessionMap.get(jid) || { history: [], nodeId: 'root' },
    setChatSession: (jid, v) => sessionMap.set(jid, v),
    getUserOrder: () => [],
    addItemToOrder: () => {},
    getPendingQuantityItem: () => null,
    getWaitingForData: () => null,
    getWaitingForFile: () => null,
    setPedidoFinalizado: () => {},
    getPedidoFinalizado: () => false,
    getWaitingTurnoReminder: () => null,
    getWaitingTurnoCascada: () => null,
    getWaitingTurnoWaitlistName: () => null,
    getMisTurnoSeleccionado: () => null,
    getMisTurnos: () => null,
    getWaitingTurnoReprogram: () => null,
    getWaitingTurnoDate: () => null,
    getWaitingTurnoSlot: () => null,
    getWaitingTurnoConfirm: () => null,
};

const svc = new MenuDbService({ clientId: 'test_inmobiliaria' });
const sheetsMock = {
    getNodesByParent: (p) => svc.getNodesByParent(p),
    getNodeById: (id) => svc.getNodeById(id),
    clientId: 'test_inmobiliaria',
};

const msgs = [];
const sock = {
    sendMessage: async (jid, m) => { msgs.push(m); },
    sendPresenceUpdate: async () => {},
    sendPresenceComposing: async () => {},
    sendPresenceUpdateStreamTyping: async () => {},
    sendPresenceUpdateStreamRecording: async () => {},
};

(async () => {
    const controller = new MenuController(sheetsMock, stateService, null);
    // Simular que ya estamos en Alquileres y elegimos "1" (Casa 3 habitaciones)
    stateMap.set('TEST', 'menu_opcion1');
    await controller.handleIncomingMessage(sock, 'TEST', '1');
    const sesion = stateService.getChatSession('TEST');
    console.log('interes tras abrir ficha:', JSON.stringify(sesion.interes));
    const ok = sesion.interes && sesion.interes.trigger === '1' && sesion.interes.title.includes('Casa');
    console.log(ok ? 'OK ✓ interés de la ficha guardado' : '✗ no se guardó');
    process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });