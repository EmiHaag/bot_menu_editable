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
    min_notice_hours: 2,
    reminder_enabled: false,
    reminder_hours_before: 24,
    waitlist_enabled: false,
    mis_turnos_enabled: true,
    mis_turnos_cancelar: true,
    recordatorio_cancelar: true,
    reprogramar_enabled: true
};

const DEFAULT_AI_CONFIG = {
    enabled: false,
    estilo: 'profesional',
    promptCustom: '',
    instrucciones: '',
    sugerirComplemento: false,
    activadoEn: null,
    vendedor: { nombre: '', telefono: '', mensaje: '' }
};

const DEFAULT_MENU_CONFIG = {
    // Minutos que el bot queda en silencio (no responde texto libre) tras finalizar
    // un pedido con comprobante. 0 = desactivado (comportamiento actual).
    silence_after_order_minutes: 0
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
        await sql`ALTER TABLE bots ADD COLUMN IF NOT EXISTS ai_config JSONB NOT NULL DEFAULT '{}'::jsonb`;
        await sql`ALTER TABLE bots ADD COLUMN IF NOT EXISTS menu_config JSONB NOT NULL DEFAULT '{}'::jsonb`;
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
        await sql`ALTER TABLE turnos ADD COLUMN IF NOT EXISTS recordatorio_enviado BOOLEAN NOT NULL DEFAULT false`;
        await sql`
            CREATE TABLE IF NOT EXISTS lista_espera (
                id SERIAL PRIMARY KEY,
                id_cliente VARCHAR(100) NOT NULL,
                fecha_inicio TIMESTAMPTZ NOT NULL,
                cliente_telefono VARCHAR(100) DEFAULT '',
                cliente_nombre TEXT DEFAULT '',
                estado VARCHAR(20) NOT NULL DEFAULT 'esperando',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `;
        await sql`CREATE INDEX IF NOT EXISTS lista_espera_slot_idx ON lista_espera (id_cliente, fecha_inicio, estado)`;
        console.log('[BotConfigService] Tables bots/turnos/lista_espera ready');
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
                calendar_config: { ...DEFAULT_CALENDAR_CONFIG, business_hours: JSON.parse(JSON.stringify(DEFAULT_CALENDAR_CONFIG.business_hours)) },
                ai_config: { ...DEFAULT_AI_CONFIG },
                menu_config: { ...DEFAULT_MENU_CONFIG }
            };
        } else {
            const row = rows[0];
            cfg = {
                idCliente: row.id_cliente,
                bot_type: row.bot_type || 'CARRITO',
                calendar_config: parseJson(row.calendar_config, { ...DEFAULT_CALENDAR_CONFIG }),
                ai_config: parseJson(row.ai_config, { ...DEFAULT_AI_CONFIG }),
                menu_config: parseJson(row.menu_config, { ...DEFAULT_MENU_CONFIG })
            };
            cfg.calendar_config = {
                ...DEFAULT_CALENDAR_CONFIG,
                ...cfg.calendar_config
            };
            cfg.ai_config = {
                ...DEFAULT_AI_CONFIG,
                ...cfg.ai_config
            };
            cfg.menu_config = {
                ...DEFAULT_MENU_CONFIG,
                ...cfg.menu_config
            };
        }
        cache.set(cacheKey, cfg);
        return cfg;
    } catch (err) {
        console.error('[BotConfigService] Error reading bot config:', err.message);
        return { bot_type: 'CARRITO', calendar_config: { ...DEFAULT_CALENDAR_CONFIG } };
    }
}

async function saveBotConfig(idCliente, { bot_type, calendar_config, ai_config, menu_config }) {
    if (!sql || !idCliente) return false;
    try {
        await sql`
            INSERT INTO bots (id_cliente, bot_type, calendar_config, ai_config, menu_config, updated_at)
            VALUES (${idCliente}, ${bot_type || 'CARRITO'}, ${JSON.stringify(calendar_config || {})}, ${JSON.stringify(ai_config || {})}, ${JSON.stringify(menu_config || {})}, NOW())
            ON CONFLICT (id_cliente) DO UPDATE SET
                bot_type = EXCLUDED.bot_type,
                calendar_config = EXCLUDED.calendar_config,
                ai_config = EXCLUDED.ai_config,
                menu_config = EXCLUDED.menu_config,
                updated_at = NOW()
        `;
        cache.del(`bot_config_${idCliente}`);
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error saving bot config:', err.message);
        return false;
    }
}

function normalizarTelefono(telefono) {
    if (!telefono) return '';
    return String(telefono).split('@')[0];
}

async function registrarTurno({ googleEventId, idCliente, clienteTelefono, clienteNombre, fechaInicio, fechaFin }) {
    if (!sql || !googleEventId || !idCliente) return false;
    const numero = normalizarTelefono(clienteTelefono);
    try {
        await sql`
            INSERT INTO turnos (google_event_id, id_cliente, cliente_telefono, cliente_nombre, fecha_inicio, fecha_fin, estado)
            VALUES (${googleEventId}, ${idCliente}, ${numero}, ${clienteNombre || ''}, ${fechaInicio}, ${fechaFin}, 'activo')
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
            WHERE id_cliente = ${idCliente}
                AND estado IN ('activo', 'recordado', 'confirmado')
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

/**
 * Turnos que ya deberían haber recibido recordatorio según horasAntes.
 * Solo procesa los que están 'activo' (aún sin recordatorio) y dentro del umbral.
 */
async function getTurnosARecordar(idCliente, horasAntes) {
    if (!sql || !idCliente) return [];
    try {
        const rows = await sql`
            SELECT * FROM turnos
            WHERE id_cliente = ${idCliente}
                AND estado = 'activo'
                AND recordatorio_enviado = false
                AND EXTRACT(EPOCH FROM (fecha_inicio - NOW())) / 3600 <= ${horasAntes}
                AND fecha_inicio > NOW()
            ORDER BY fecha_inicio ASC
        `;
        return rows;
    } catch (err) {
        console.error('[BotConfigService] Error obteniendo turnos a recordar:', err.message);
        return [];
    }
}

/**
 * Turnos próximos dentro de X horas que aún son válidos (incluye los ya confirmados).
 * Se usa para el recordatorio de proximidad (corta anticipación) que sí llega
 * aunque el cliente ya haya confirmado el turno.
 */
async function getTurnosProximos(idCliente, horas) {
    if (!sql || !idCliente) return [];
    try {
        const rows = await sql`
            SELECT * FROM turnos
            WHERE id_cliente = ${idCliente}
                AND estado IN ('activo', 'confirmado', 'recordado')
                AND recordatorio_enviado = false
                AND EXTRACT(EPOCH FROM (fecha_inicio - NOW())) / 3600 <= ${horas}
                AND fecha_inicio > NOW()
            ORDER BY fecha_inicio ASC
        `;
        return rows;
    } catch (err) {
        console.error('[BotConfigService] Error obteniendo turnos próximos:', err.message);
        return [];
    }
}

async function marcarRecordatorioEnviado(googleEventId) {
    if (!sql || !googleEventId) return false;
    try {
        await sql`
            UPDATE turnos
            SET recordatorio_enviado = true, estado = CASE WHEN estado = 'activo' THEN 'recordado' ELSE estado END
            WHERE google_event_id = ${googleEventId}
        `;
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error marcando recordatorio enviado:', err.message);
        return false;
    }
}

async function actualizarEstadoTurno(googleEventId, estado) {
    if (!sql || !googleEventId || !estado) return false;
    try {
        await sql`UPDATE turnos SET estado = ${estado} WHERE google_event_id = ${googleEventId}`;
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error actualizando estado de turno:', err.message);
        return false;
    }
}

async function getTurnoByGoogleEventId(googleEventId) {
    if (!sql || !googleEventId) return null;
    try {
        const rows = await sql`SELECT * FROM turnos WHERE google_event_id = ${googleEventId} LIMIT 1`;
        return rows[0] || null;
    } catch (err) {
        console.error('[BotConfigService] Error obteniendo turno por evento:', err.message);
        return null;
    }
}

async function getTurnosByTelefono(idCliente, clienteTelefono) {
    if (!sql || !idCliente || !clienteTelefono) return [];
    const numero = normalizarTelefono(clienteTelefono);
    try {
        const rows = await sql`
            SELECT * FROM turnos
            WHERE id_cliente = ${idCliente}
                AND estado IN ('activo', 'recordado', 'confirmado')
            ORDER BY fecha_inicio ASC
        `;
        // Filtro en JS para tolerar filas viejas con el jid completo y las nuevas con número
        return rows.filter((r) => normalizarTelefono(r.cliente_telefono) === numero);
    } catch (err) {
        console.error('[BotConfigService] Error obteniendo turnos por teléfono:', err.message);
        return [];
    }
}

async function registrarEnListaEspera({ idCliente, fechaInicio, clienteTelefono, clienteNombre }) {
    if (!sql || !idCliente || !fechaInicio) return false;
    const numero = normalizarTelefono(clienteTelefono);
    try {
        await sql`
            INSERT INTO lista_espera (id_cliente, fecha_inicio, cliente_telefono, cliente_nombre, estado)
            VALUES (${idCliente}, ${fechaInicio}, ${numero}, ${clienteNombre || ''}, 'esperando')
        `;
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error registrando en lista de espera:', err.message);
        return false;
    }
}

async function getListaEsperaParaSlot(idCliente, fechaInicio) {
    if (!sql || !idCliente || !fechaInicio) return [];
    try {
        const rows = await sql`
            SELECT * FROM lista_espera
            WHERE id_cliente = ${idCliente} AND fecha_inicio = ${fechaInicio}
                AND estado IN ('esperando', 'ofrecido')
            ORDER BY created_at ASC
        `;
        return rows;
    } catch (err) {
        console.error('[BotConfigService] Error obteniendo lista de espera del slot:', err.message);
        return [];
    }
}

async function marcarEstadoListaEspera(id, estado) {
    if (!sql || !id || !estado) return false;
    try {
        await sql`UPDATE lista_espera SET estado = ${estado} WHERE id = ${id}`;
        return true;
    } catch (err) {
        console.error('[BotConfigService] Error actualizando estado de lista de espera:', err.message);
        return false;
    }
}

module.exports = {
    ensureTable,
    getBotConfig,
    saveBotConfig,
    registrarTurno,
    getTurnosByIdCliente,
    getTurnosByTelefono,
    cancelarTurnoLocal,
    getTurnosARecordar,
    getTurnosProximos,
    marcarRecordatorioEnviado,
    actualizarEstadoTurno,
    getTurnoByGoogleEventId,
    registrarEnListaEspera,
    getListaEsperaParaSlot,
    marcarEstadoListaEspera,
    DEFAULT_CALENDAR_CONFIG,
    DEFAULT_AI_CONFIG
};