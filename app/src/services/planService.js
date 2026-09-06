/**
 * PlanService: verificación del plan premium de un comercio.
 * Premium = plan 'premium' Y usuario activo (users.activo = true)
 * (ignora fecha de vencimiento del estado de suscripción).
 */
const NodeCache = require('node-cache');
const userService = require('./userService');

const cache = new NodeCache({ stdTTL: 600 });

/**
 * Verifica si un comercio tiene acceso a funcionalidades premium.
 * @param {string} comercioId
 * @returns {Promise<boolean>}
 */
async function verificarPlanPremium(comercioId) {
    if (!comercioId) return false;
    const cacheKey = `plan_premium_${comercioId}`;
    const cached = cache.get(cacheKey);
    if (typeof cached === 'boolean') return cached;

    const user = await userService.getUserByIdCliente(comercioId).catch(() => null);
    const premium = !!(user && user.plan === 'premium' && user.activo === true);
    cache.set(cacheKey, premium);
    return premium;
}

module.exports = { verificarPlanPremium };