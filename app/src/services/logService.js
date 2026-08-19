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

async function log({ level = 'info', category = 'system', userId = '', message = '', meta = null }) {
  if (!sql) return null;
  try {
    const rows = await sql`
      INSERT INTO system_logs (level, category, user_id, message, meta)
      VALUES (${level}, ${category}, ${userId || ''}, ${message || ''}, ${meta ? JSON.stringify(meta) : null})
      RETURNING id
    `;
    return rows[0]?.id || null;
  } catch (err) {
    console.error('[LogService] Error insertando log:', err.message);
    return null;
  }
}

async function track({ userId = '', action = '', entity = '', message = '', meta = null, ip = '' }) {
  if (!sql) return null;
  try {
    const rows = await sql`
      INSERT INTO user_events (user_id, action, entity, message, meta, ip)
      VALUES (${userId || ''}, ${action || ''}, ${entity || ''}, ${message || ''}, ${meta ? JSON.stringify(meta) : null}, ${ip || ''})
      RETURNING id
    `;
    return rows[0]?.id || null;
  } catch (err) {
    console.error('[LogService] Error insertando evento de usuario:', err.message);
    return null;
  }
}

async function getLogs({ level = '', category = '', userId = '', search = '', limit = 200, offset = 0 } = {}) {
  if (!sql) return [];
  try {
    const conditions = [];
    if (level) conditions.push(sql`level = ${level}`);
    if (category) conditions.push(sql`category = ${category}`);
    if (userId) conditions.push(sql`user_id = ${userId}`);
    if (search) conditions.push(sql`(message ILIKE ${'%' + search + '%'} OR user_id ILIKE ${'%' + search + '%'} OR category ILIKE ${'%' + search + '%'})`);

    const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, ' AND ')}` : sql``;

    const rows = await sql`
      SELECT id, level, category, user_id, message, meta, created_at
      FROM system_logs
      ${where}
      ORDER BY created_at DESC
      LIMIT ${Number(limit) || 200}
      OFFSET ${Number(offset) || 0}
    `;
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
    if (userId) conditions.push(sql`user_id = ${userId}`);
    if (action) conditions.push(sql`action = ${action}`);
    if (search) conditions.push(sql`(message ILIKE ${'%' + search + '%'} OR entity ILIKE ${'%' + search + '%'} OR user_id ILIKE ${'%' + search + '%'})`);

    const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, ' AND ')}` : sql``;

    const rows = await sql`
      SELECT id, user_id, action, entity, message, meta, ip, created_at
      FROM user_events
      ${where}
      ORDER BY created_at DESC
      LIMIT ${Number(limit) || 200}
      OFFSET ${Number(offset) || 0}
    `;
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
  getEventActions,
};