require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { MenuDbService } = require(ROOT + '/app/src/services/menuDbService');
const MenuController = require(ROOT + '/app/src/controllers/menuController');

const stateMap = new Map();
const stateService = {
    clientId: 'test_inmobiliaria',
    getUserState: (jid) => stateMap.get(jid) || 'root',
    setUserState: (jid, v) => stateMap.set(jid, v),
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
    sendMessage: async (jid, m) => { msgs.push(m); console.log('[envio]', m.image ? 'IMAGEN ' + m.image.url.slice(0, 60) : 'TEXTO ' + JSON.stringify(m.text).slice(0, 90)); },
    sendPresenceUpdate: async () => {},
    sendPresenceComposing: async () => {},
};

(async () => {
    const controller = new MenuController(sheetsMock, stateService, null);
    // Simular que ya estamos en Alquileres
    stateMap.set('TEST', 'menu_opcion1');
    await controller.handleIncomingMessage(sock, 'TEST', '1');
    console.log('\n[imagenes enviadas]', msgs.filter(m => m.image).length);
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });