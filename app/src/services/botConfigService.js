const { neon } = require('@neondatabase/serverless');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 300 });

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

const DEFAULT_CALENDAR_CONFIG = {
    calendar_id: '',
    time_zone: 'America/Argentina/Buenos_Aires',
    slot_duration_minutes: 30,
    business_hours: {
        '1': [{ desde: '09:00', hasta: '18:00' }],
        '2': [{ desde: '09:00', hasta: '18:00' }],
        '3': [{ desde: '09:00', hasta: '18:00' }],
        '4': [{ desde: '09:00', hasta: '18:00' }],
        '5': [{ desde: '09:00', hasta: '18:00' }]
    },
    min_notice_hours: 2
};

async function ensureTable() {
    if (!sql) {
        console.error('[BotConfigService] NEON_DATABASE_URL not set, bot config service disabled');
        return;
    }
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS bots (
                id_cliente VARCHAR(100) PRIMARY KEY,
                bot_type VARCHAR(20) NOT NULL DEFAULT 'CARRITO',
                calendar_config JSONB NOT NULL DEFAULT '{}'::jsonb,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        await sql`
            CREATE TABLE IF NOT EXISTS turnos (
                id SERIAL PRIMARY KEY,
                google_event_id VARCHAR(200) NOT NULL,
                id_cliente VARCHAR(100) NOT NULL,
                cliente_telefono VARCHAR(100) DEFAULT '',
                cliente_nombre TEXT DEFAULT '',
                fecha_inicio TIMESTAMPTZ NOT NULL,
                fecha_fin TIMESTAMPTZ NOT NULL,
                estado VARCHAR(20) NOT NULL DEFAULT 'activo',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        await sql`
            CREATE UNIQUE INDEX IF NOT EXISTS turnos_event_uq ON turnos (google_event_id)
        `;
        console.log('[BotConfigService] Tables bots/turnos ready');
    } catch (err) {
        console.error('[BotConfigService] Error ensuring tables:', err.message);
    }
}

function parseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function getBotConfig(idCliente) {
    if (!sql || !idCliente) {
        return { bot_type: 'CARRITO', calendar_config: { ...DEFAULT_CALENDAR_CONFIG } };
    }
    const cacheKey = `bot_config_${idCliente}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
        const rows = await sql`SELECT * FROM bots WHERE id_cliente = ${idCliente}`;
        let cfg;
        if (rows.length === 0) {
            cfg = {
                idCliente,
                bot_type: 'CARRITO',
                calendar_config: { ...DEFAULT_CALENDAR_CONFIG, business_hours: JSON.parse(JSON.stringify(DEFAULT_CALENDAR_CONFIG.business_hours)) }
            };
        } else {
            const row = rows[0];
            cfg = {
                idCliente: row.id_cliente,
                bot_type: row.bot_type || 'CARRITO',
                calendar_config: parseJson(row.calendar_config, { ...DEFAULT_CALENDAR_CONFIG })
            };
            cfg.calendar_config = {
                ...DEFAULT_CALENDAR_CONFIG,
                ...cfg.calendar_config
            };
        }
        cache.set(cacheKey, cfg);
        return cfg;
    } catch (err) {
        console.error('[BotConfigService] Error reading bot config:', err.message);
        return { bot_type: 'CARRITO', calendar_config: { ...DEFAULT_CALENDAR_CONFIG } };
    }
}

async function saveBotConfig(idCliente, { bot_type, calendar_config }) {
    if (!sql || !idCliente) return false;
    try {
        await sql`
            INSERT INTO bots (id_cliente, bot_type, calendar_config, updated_at)
            VALUES (${idCliente}, ${bot_type || 'CARRITO'}, ${JSON.stringify(calendar_config || {})}, NOW())
            ON CONFLICT (id_cliente) DO UPDATE SET
                bot_type = EXCLUDED.bot_type,
                calendar_config = EXCLUDED.calendar_config,
                updated_at = NOW()
        `;
        cache.del(`bot_config_${idCliente}`);
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error saving bot config:', err.message);
        return false;
    }
}

async function registrarTurno({ googleEventId, idCliente, clienteTelefono, clienteNombre, fechaInicio, fechaFin }) {
    if (!sql || !googleEventId || !idCliente) return false;
    try {
        await sql`
            INSERT INTO turnos (google_event_id, id_cliente, cliente_telefono, cliente_nombre, fecha_inicio, fecha_fin, estado)
            VALUES (${googleEventId}, ${idCliente}, ${clienteTelefono || ''}, ${clienteNombre || ''}, ${fechaInicio}, ${fechaFin}, 'activo')
            ON CONFLICT (google_event_id) DO NOTHING
        `;
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error registrando turno:', err.message);
        return false;
    }
}

async function getTurnosByIdCliente(idCliente) {
    if (!sql || !idCliente) return [];
    try {
        const rows = await sql`
            SELECT * FROM turnos
            WHERE id_cliente = ${idCliente} AND estado = 'activo'
            ORDER BY fecha_inicio ASC
        `;
        return rows;
    } catch (err) {
        console.error('[BotConfigService] Error obteniendo turnos:', err.message);
        return [];
    }
}

async function cancelarTurnoLocal(googleEventId) {
    if (!sql || !googleEventId) return false;
    try {
        await sql`UPDATE turnos SET estado = 'cancelado' WHERE google_event_id = ${googleEventId}`;
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error cancelando turno local:', err.message);
        return false;
    }
}

module.exports = {
    ensureTable,
    getBotConfig,
    saveBotConfig,
    registrarTurno,
    getTurnosByIdCliente,
    cancelarTurnoLocal,
    DEFAULT_CALENDAR_CONFIG
};