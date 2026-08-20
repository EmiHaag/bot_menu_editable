const { neon } = require('@neondatabase/serverless');

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

async function ensureTable() {
  if (!sql) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        level VARCHAR(20) NOT NULL DEFAULT 'info',   -- info | warning | error
        category VARCHAR(50) NOT NULL DEFAULT 'system',
        user_id VARCHAR(100) DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        meta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs (created_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs (level)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS user_events (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL DEFAULT '',
        action VARCHAR(100) NOT NULL DEFAULT '',
        entity VARCHAR(100) DEFAULT '',
        message TEXT DEFAULT '',
        meta JSONB,
        ip VARCHAR(50) DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_events_created ON user_events (created_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_user_events_user ON user_events (user_id)
    `;
    console.log('[LogService] Tables system_logs/user_events ready');
  } catch (err) {
    console.error('[LogService] Error ensuring tables:', err.message);
  }
}

// --- Batch de escritura: acumula inserts y los vuelca en una sola query ---
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_QUEUE = 5000;

let logQueue = [];
let eventQueue = [];
let flushTimer = null;
let flushing = false;

function scheduleFlush() {
  if (flushing) return;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

async function flush() {
  if (flushing) return;
  if (!sql) return;
  if (logQueue.length === 0 && eventQueue.length === 0) return;
  flushing = true;
  flushTimer = null;
  const logs = logQueue.splice(0, MAX_QUEUE);
  const events = eventQueue.splice(0, MAX_QUEUE);
  try {
    if (logs.length) await insertLogsBatch(logs);
    if (events.length) await insertEventsBatch(events);
  } catch (err) {
    console.error('[LogService] Error volcando logs a la BD:', err.message);
  } finally {
    flushing = false;
    if (logQueue.length || eventQueue.length) scheduleFlush();
  }
}

async function insertLogsBatch(entries) {
  const levels = entries.map(e => e.level || 'info');
  const categories = entries.map(e => e.category || 'system');
  const userIds = entries.map(e => e.userId || '');
  const messages = entries.map(e => String(e.message || '').slice(0, 2000));
  const metas = entries.map(e => (e.meta !== null && e.meta !== undefined) ? JSON.stringify(e.meta) : null);
  await sql.query(`
    INSERT INTO system_logs (level, category, user_id, message, meta)
    SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[])
  `, [levels, categories, userIds, messages, metas]);
}

async function insertEventsBatch(entries) {
  const userIds = entries.map(e => e.userId || '');
  const actions = entries.map(e => e.action || '');
  const entities = entries.map(e => e.entity || '');
  const messages = entries.map(e => String(e.message || ''));
  const metas = entries.map(e => (e.meta !== null && e.meta !== undefined) ? JSON.stringify(e.meta) : null);
  const ips = entries.map(e => e.ip || '');
  await sql.query(`
    INSERT INTO user_events (user_id, action, entity, message, meta, ip)
    SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[], $6::text[])
  `, [userIds, actions, entities, messages, metas, ips]);
}

// Intento de volcar lo pendiente antes de que el proceso se apague
async function flushOnExit() {
  try { await flush(); } catch (e) {}
}
process.on('SIGTERM', flushOnExit);
process.on('SIGINT', flushOnExit);
process.on('beforeExit', flushOnExit);

// --- Limpieza periódica: elimina logs/eventos con más de 7 días ---
const RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

async function cleanupOld() {
  if (!sql) return;
  try {
    const logs = await sql`DELETE FROM system_logs WHERE created_at < NOW() - make_interval(days => ${RETENTION_DAYS}) RETURNING id`;
    const events = await sql`DELETE FROM user_events WHERE created_at < NOW() - make_interval(days => ${RETENTION_DAYS}) RETURNING id`;
    if (logs.length || events.length) {
      console.log(`[LogService] Limpieza: ${logs.length} logs y ${events.length} eventos antiguos eliminados`);
    }
  } catch (err) {
    console.error('[LogService] Error limpiando logs antiguos:', err.message);
  }
}

function startCleanup() {
  cleanupOld();
  setInterval(cleanupOld, CLEANUP_INTERVAL_MS);
}

function log({ level = 'info', category = 'system', userId = '', message = '', meta = null } = {}) {
  if (!sql) return Promise.resolve(null);
  logQueue.push({ level, category, userId, message, meta });
  scheduleFlush();
  return Promise.resolve(null);
}

function track({ userId = '', action = '', entity = '', message = '', meta = null, ip = '' } = {}) {
  if (!sql) return Promise.resolve(null);
  eventQueue.push({ userId, action, entity, message, meta, ip });
  scheduleFlush();
  return Promise.resolve(null);
}

async function getLogs({ level = '', category = '', userId = '', search = '', limit = 200, offset = 0 } = {}) {
  if (!sql) return [];
  try {
    const conditions = [];
    const params = [];
    if (level) { params.push(level); conditions.push(`level = $${params.length}`); }
    if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
    if (userId) { params.push(userId); conditions.push(`user_id = $${params.length}`); }
    if (search) {
      params.push('%' + search + '%');
      const p = params.length;
      conditions.push(`(message ILIKE $${p} OR user_id ILIKE $${p} OR category ILIKE $${p})`);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await sql.query(`
      SELECT id, level, category, user_id, message, meta, created_at
      FROM system_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ${Number(limit) || 200}
      OFFSET ${Number(offset) || 0}
    `, params);
    return rows;
  } catch (err) {
    console.error('[LogService] Error obteniendo logs:', err.message);
    return [];
  }
}

async function getEvents({ userId = '', action = '', search = '', limit = 200, offset = 0 } = {}) {
  if (!sql) return [];
  try {
    const conditions = [];
    const params = [];
    if (userId) { params.push(userId); conditions.push(`user_id = $${params.length}`); }
    if (action) { params.push(action); conditions.push(`action = $${params.length}`); }
    if (search) {
      params.push('%' + search + '%');
      const p = params.length;
      conditions.push(`(message ILIKE $${p} OR entity ILIKE $${p} OR user_id ILIKE $${p})`);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await sql.query(`
      SELECT id, user_id, action, entity, message, meta, ip, created_at
      FROM user_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ${Number(limit) || 200}
      OFFSET ${Number(offset) || 0}
    `, params);
    return rows;
  } catch (err) {
    console.error('[LogService] Error obteniendo eventos:', err.message);
    return [];
  }
}

// Usuarios distintos que aparecen en los logs (para el filtro)
async function getLogUsers() {
  if (!sql) return [];
  try {
    const rows = await sql`
      SELECT DISTINCT user_id FROM system_logs WHERE user_id <> '' ORDER BY user_id
    `;
    return rows.map(r => r.user_id);
  } catch (err) {
    return [];
  }
}

// Usuarios distintos que aparecen en los eventos (para el filtro)
async function getEventUsers() {
  if (!sql) return [];
  try {
    const rows = await sql`
      SELECT DISTINCT user_id FROM user_events WHERE user_id <> '' ORDER BY user_id
    `;
    return rows.map(r => r.user_id);
  } catch (err) {
    return [];
  }
}

// Acciones distintas registradas en eventos (para el filtro)
async function getEventActions() {
  if (!sql) return [];
  try {
    const rows = await sql`
      SELECT DISTINCT action FROM user_events WHERE action <> '' ORDER BY action
    `;
    return rows.map(r => r.action);
  } catch (err) {
    return [];
  }
}

module.exports = {
  ensureTable,
  log,
  track,
  getLogs,
  getEvents,
  getLogUsers,
  getEventUsers,
  getEventActions,
  cleanupOld,
  startCleanup,
};