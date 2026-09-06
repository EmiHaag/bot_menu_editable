require('dotenv').config();
const ROOT = 'C:/Users/emili/coding/bots_koyeb/bot_menu';
const { verificarPlanPremium } = require(ROOT + '/app/src/services/planService');
const UserService = require(ROOT + '/app/src/services/userService');
(async () => {
    const u = await UserService.getUserByIdCliente('test_inmobiliaria').catch(() => null);
    console.log('USER:', JSON.stringify({ nombre: u && u.nombreCliente, plan: u && u.plan, activo: u && u.activo }));
    const prem = await verificarPlanPremium('test_inmobiliaria');
    console.log('verificarPlanPremium:', prem);
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });