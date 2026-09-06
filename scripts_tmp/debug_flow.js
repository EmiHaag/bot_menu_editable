require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { MenuDbService } = require(ROOT + '/app/src/services/menuDbService');
const UserService = require(ROOT + '/app/src/services/userService');
const BotConfigService = require(ROOT + '/app/src/services/botConfigService');

(async () => {
    const user = await UserService.getUserByIdCliente('test_inmobiliaria').catch(e => null);
    console.log('USER:', JSON.stringify({ plan: user && user.plan, activo: user && user.activo, nombre: user && user.nombreCliente }));
    const cfg = await BotConfigService.getBotConfig('test_inmobiliaria');
    const ai = (cfg && cfg.ai_config) || {};
    console.log('AI_CONFIG enabled:', ai.enabled, '| vendedor:', JSON.stringify((ai.vendedor||{}).telefono));

    const svc = new MenuDbService('test_inmobiliaria');
    const rootKids = await svc.getNodesByParent('root');
    console.log('ROOT KIDS:', rootKids.map(k => ({ id: k.id, title: k.title, trigger: k.trigger, parent: k.parentId })));

    for (const k of rootKids) {
        const kids = await svc.getNodesByParent(k.id);
        console.log('Hijos de', k.id, '->', kids.map(x => ({ id: x.id, title: x.title, trigger: x.trigger })));
    }
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });