// Logging en memoria (sin base de datos).
// Los logs y eventos viven en ring buffers en RAM y solo se consultan
// en tiempo real mientras el admin está en la pantalla correspondiente.

const MAX_LOGS = 1000;
const MAX_EVENTS = 500;

let logs = [];
let events = [];

function nowIso() {
  return new Date().toISOString();
}

function log({ level = 'info', category = 'system', userId = '', message = '', meta = null } = {}) {
  logs.unshift({
    id: (logs.length ? logs[0].id : 0) + 1,
    level,
    category,
    user_id: userId,
    message: String(message || '').slice(0, 2000),
    meta,
    created_at: nowIso()
  });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  return Promise.resolve(null);
}

function track({ userId = '', action = '', entity = '', message = '', meta = null, ip = '' } = {}) {
  events.unshift({
    id: (events.length ? events[0].id : 0) + 1,
    user_id: userId,
    action,
    entity,
    message: String(message || ''),
    meta,
    ip,
    created_at: nowIso()
  });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  return Promise.resolve(null);
}

function getLogs({ level = '', category = '', userId = '', search = '', limit = 200, offset = 0 } = {}) {
  let rows = logs;
  if (level) rows = rows.filter(r => r.level === level);
  if (category) rows = rows.filter(r => r.category === category);
  if (userId) rows = rows.filter(r => r.user_id === userId);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(r =>
      String(r.message || '').toLowerCase().includes(q) ||
      String(r.user_id || '').toLowerCase().includes(q) ||
      String(r.category || '').toLowerCase().includes(q)
    );
  }
  const slice = rows.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 200));
  return Promise.resolve(slice);
}

function getEvents({ userId = '', action = '', search = '', limit = 200, offset = 0 } = {}) {
  let rows = events;
  if (userId) rows = rows.filter(r => r.user_id === userId);
  if (action) rows = rows.filter(r => r.action === action);
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(r =>
      String(r.message || '').toLowerCase().includes(q) ||
      String(r.entity || '').toLowerCase().includes(q) ||
      String(r.user_id || '').toLowerCase().includes(q)
    );
  }
  const slice = rows.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 200));
  return Promise.resolve(slice);
}

function getLogUsers() {
  const seen = new Set();
  const out = [];
  for (const r of logs) {
    if (r.user_id && !seen.has(r.user_id)) {
      seen.add(r.user_id);
      out.push(r.user_id);
    }
  }
  return Promise.resolve(out);
}

function getEventUsers() {
  const seen = new Set();
  const out = [];
  for (const r of events) {
    if (r.user_id && !seen.has(r.user_id)) {
      seen.add(r.user_id);
      out.push(r.user_id);
    }
  }
  return Promise.resolve(out);
}

function getEventActions() {
  const seen = new Set();
  const out = [];
  for (const r of events) {
    if (r.action && !seen.has(r.action)) {
      seen.add(r.action);
      out.push(r.action);
    }
  }
  return Promise.resolve(out);
}

// No-ops para compatibilidad con la API anterior
async function ensureTable() { return; }
function startCleanup() { return; }

module.exports = {
  ensureTable,
  log,
  track,
  getLogs,
  getEvents,
  getLogUsers,
  getEventUsers,
  getEventActions,
  startCleanup,
};