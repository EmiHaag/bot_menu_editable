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
};

const svc = new MenuDbService({ clientId: 'test_inmobiliaria' });
const sheetsMock = {
    getNodesByParent: (p) => svc.getNodesByParent(p),
    getNodeById: (id) => svc.getNodeById(id),
};

const mensajes = [];
const sock = {
    sendMessage: async (jid, m) => { mensajes.push(m.text); },
    sendPresenceUpdate: async () => {},
    sendPresenceComposing: async () => {},
};

(async () => {
    const controller = new MenuController(sheetsMock, stateService, null);

    console.log('=== sendMenu(Alquileres) 1 opción ===');
    await controller.sendMenu(sock, 'TEST', 'menu_opcion1');
    console.log(mensajes.pop());
    console.log('\n=== sendMenu(root) 2 opciones ===');
    await controller.sendMenu(sock, 'TEST', 'root');
    console.log(mensajes.pop());
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });