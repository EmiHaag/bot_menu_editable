const { neon } = require('@neondatabase/serverless');

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

/**
 * Few-Shot Examples & Synthetic Logs para el clasificador de intenciones.
 *
 * Tablas:
 *  - ai_few_shot_examples: ejemplos corregidos (user_input → intent esperada).
 *  - ai_synthetic_logs: logs de cada corrida del pipeline (para auditoría).
 *
 * Los ejemplos activos se inyectan en el system prompt del clasificador.
 * UNIQUE sobre (comercio_id, user_input) para evitar duplicados.
 */

async function ensureTables() {
    if (!sql) return;
    await sql`
        CREATE TABLE IF NOT EXISTS ai_few_shot_examples (
            id            SERIAL PRIMARY KEY,
            comercio_id   TEXT NOT NULL,
            user_input    TEXT NOT NULL,
            intent        TEXT NOT NULL,
            items         JSONB DEFAULT '[]'::jsonb,
            rationale     TEXT DEFAULT '',
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(comercio_id, user_input)
        )
    `;
    await sql`
        CREATE TABLE IF NOT EXISTS ai_synthetic_logs (
            id            SERIAL PRIMARY KEY,
            comercio_id   TEXT NOT NULL,
            user_input    TEXT NOT NULL,
            bot_intent    TEXT NOT NULL,
            bot_items     JSONB DEFAULT '[]'::jsonb,
            judge_verdict TEXT NOT NULL,
            judge_reason  TEXT DEFAULT '',
            corrected     BOOLEAN DEFAULT FALSE,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_few_shot_comercio ON ai_few_shot_examples(comercio_id)`;
}

// ── CRUD Few-Shot Examples ──────────────────────────────────────────────────

/**
 * Obtiene ejemplos few-shot activos para un comercio (ordenados por created_at DESC, máx 15).
 */
async function getExamples(comercioId) {
    if (!sql) return [];
    const rows = await sql`
        SELECT user_input, intent, items, rationale
        FROM ai_few_shot_examples
        WHERE comercio_id = ${comercioId}
        ORDER BY created_at DESC
        LIMIT 15
    `;
    return rows.map(r => ({
        userInput: r.user_input,
        intent: r.intent,
        items: r.items || [],
        rationale: r.rationale || ''
    }));
}

/**
 * Inserta o actualiza un ejemplo few-shot (upsert por UNIQUE).
 */
async function upsertExample(comercioId, { userInput, intent, items, rationale }) {
    if (!sql) return null;
    const rows = await sql`
        INSERT INTO ai_few_shot_examples (comercio_id, user_input, intent, items, rationale)
        VALUES (${comercioId}, ${userInput}, ${intent}, ${JSON.stringify(items || [])}, ${rationale || ''})
        ON CONFLICT (comercio_id, user_input)
        DO UPDATE SET
            intent    = EXCLUDED.intent,
            items     = EXCLUDED.items,
            rationale = EXCLUDED.rationale,
            created_at = NOW()
        RETURNING id
    `;
    return rows[0]?.id || null;
}

/**
 * Inserta varios ejemplos de una vez (batch upsert).
 */
async function batchUpsert(comercioId, examples) {
    if (!sql || !examples.length) return 0;
    let count = 0;
    for (const ex of examples) {
        const id = await upsertExample(comercioId, ex);
        if (id) count++;
    }
    return count;
}

/**
 * Borra todos los ejemplos de un comercio.
 */
async function clearExamples(comercioId) {
    if (!sql) return 0;
    const rows = await sql`DELETE FROM ai_few_shot_examples WHERE comercio_id = ${comercioId} RETURNING id`;
    return rows.length;
}

/**
 * Cuenta ejemplos de un comercio.
 */
async function countExamples(comercioId) {
    if (!sql) return 0;
    const rows = await sql`SELECT COUNT(*)::int AS cnt FROM ai_few_shot_examples WHERE comercio_id = ${comercioId}`;
    return rows[0]?.cnt || 0;
}

/**
 * Cuenta ejemplos agrupados por intención (para límite de diversidad).
 */
async function getCountsByIntent(comercioId) {
    if (!sql) return {};
    const rows = await sql`SELECT intent, COUNT(*)::int AS cnt FROM ai_few_shot_examples WHERE comercio_id = ${comercioId} GROUP BY intent`;
    const map = {};
    for (const r of rows) map[r.intent] = r.cnt;
    return map;
}

/**
 * Todos los inputs (normalizados para dedup) de un comercio.
 */
async function getAllUserInputs(comercioId) {
    if (!sql) return [];
    const rows = await sql`SELECT user_input FROM ai_few_shot_examples WHERE comercio_id = ${comercioId}`;
    return rows.map(r => r.user_input);
}

/**
 * Borra el ejemplo más antiguo de una intención (ventana deslizante).
 */
async function deleteOldestForIntent(comercioId, intent) {
    if (!sql) return null;
    const rows = await sql`
        DELETE FROM ai_few_shot_examples
        WHERE comercio_id = ${comercioId} AND intent = ${intent}
          AND id = (SELECT id FROM ai_few_shot_examples
                    WHERE comercio_id = ${comercioId} AND intent = ${intent}
                    ORDER BY created_at ASC LIMIT 1)
        RETURNING id
    `;
    return rows[0]?.id || null;
}

/**
 * Borra un ejemplo por su input exacto (rollback del pipeline).
 */
async function deleteByInput(comercioId, userInput) {
    if (!sql) return 0;
    const rows = await sql`DELETE FROM ai_few_shot_examples WHERE comercio_id = ${comercioId} AND user_input = ${userInput} RETURNING id`;
    return rows.length;
}

// ── Logs del Pipeline ───────────────────────────────────────────────────────

async function saveLog(comercioId, { userInput, botIntent, botItems, judgeVerdict, judgeReason, corrected }) {
    if (!sql) return null;
    const rows = await sql`
        INSERT INTO ai_synthetic_logs (comercio_id, user_input, bot_intent, bot_items, judge_verdict, judge_reason, corrected)
        VALUES (${comercioId}, ${userInput}, ${botIntent}, ${JSON.stringify(botItems || [])}, ${judgeVerdict}, ${judgeReason || ''}, ${!!corrected})
        RETURNING id
    `;
    return rows[0]?.id || null;
}

/**
 * Últimos logs de un comercio (para auditoría, máx 50).
 */
async function getLogs(comercioId, limit = 50) {
    if (!sql) return [];
    const rows = await sql`
        SELECT user_input, bot_intent, judge_verdict, judge_reason, corrected, created_at
        FROM ai_synthetic_logs
        WHERE comercio_id = ${comercioId}
        ORDER BY created_at DESC
        LIMIT ${limit}
    `;
    return rows;
}

/**
 * Resumen de logs de un comercio.
 */
async function getStats(comercioId) {
    if (!sql) return { total: 0, corrected: 0, passRate: 0 };
    const rows = await sql`
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE corrected)::int AS corrected
        FROM ai_synthetic_logs
        WHERE comercio_id = ${comercioId}
    `;
    const r = rows[0] || { total: 0, corrected: 0 };
    return {
        total: r.total,
        corrected: r.corrected,
        passRate: r.total > 0 ? Math.round(((r.total - r.corrected) / r.total) * 100) : 0
    };
}

module.exports = {
    ensureTables,
    getExamples,
    upsertExample,
    batchUpsert,
    clearExamples,
    countExamples,
    getCountsByIntent,
    getAllUserInputs,
    deleteOldestForIntent,
    deleteByInput,
    saveLog,
    getLogs,
    getStats
};
