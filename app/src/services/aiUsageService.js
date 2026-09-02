const { neon } = require('@neondatabase/serverless');

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

const LIMIT_TOKENS = 1_000_000;
const WINDOW_DAYS = 30;

async function ensureTable() {
    if (!sql) return;
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS ai_usage (
                id_cliente VARCHAR(100) NOT NULL,
                dia VARCHAR(10) NOT NULL,
                tokens_used BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (id_cliente, dia)
            )
        `;
        console.log('[AIUsageService] Table ai_usage ready');
    } catch (err) {
        console.error('[AIUsageService] Error ensuring table:', err.message);
    }
}

function _diaKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function _shiftDays(daysAgo) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d;
}

/**
 * Suma de tokens usados en la ventana de 30 días.
 * @param {string} idCliente
 * @param {string|null} activadoEn - fecha ISO de activación (o null).
 * @returns {Promise<number>}
 */
async function getTokensUsed(idCliente, activadoEn) {
    if (!sql || !idCliente) return 0;
    try {
        const since = _shiftDays(WINDOW_DAYS - 1);
        const windowStart = activadoEn ? _diaKey(new Date(activadoEn)) : _diaKey(since);
        const today = _diaKey();
        const rows = await sql`
            SELECT COALESCE(SUM(tokens_used), 0) AS total
            FROM ai_usage
            WHERE id_cliente = ${idCliente} AND dia >= ${windowStart}
        `;
        return rows && rows[0] ? Number(rows[0].total) : 0;
    } catch (err) {
        console.error('[AIUsageService] Error getTokensUsed:', err.message);
        return 0;
    }
}

async function addTokens(idCliente, tokens) {
    if (!sql || !idCliente || !tokens || tokens <= 0) return;
    try {
        const dia = _diaKey();
        await sql`
            INSERT INTO ai_usage (id_cliente, dia, tokens_used)
            VALUES (${idCliente}, ${dia}, ${Math.round(tokens)})
            ON CONFLICT (id_cliente, dia) DO UPDATE SET
                tokens_used = ai_usage.tokens_used + EXCLUDED.tokens_used
        `;
    } catch (err) {
        console.error('[AIUsageService] Error addTokens:', err.message);
    }
}

module.exports = {
    ensureTable,
    getTokensUsed,
    addTokens,
    LIMIT_TOKENS,
    WINDOW_DAYS
};
