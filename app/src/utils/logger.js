const logService = require('../services/logService');

const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

let captureActive = false;
let skipCapture = false;

// Deduplicación simple: evita inundar la BD con mensajes repetidos en bucle.
const recent = new Map();
const DEDUPE_MS = 60000;
const MAX_PER_WINDOW = 40;

function safeStringify(v) {
  try {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.message + (v.stack ? ' ' + v.stack : '');
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

function shouldCapture(level, message) {
  const key = level + '::' + message;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return false;
  recent.set(key, now);
  if (recent.size > 500) {
    const oldest = [...recent.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) recent.delete(oldest[0]);
  }
  // límite total por ventana de 60s
  const nowMs = now;
  let count = 0;
  for (const t of recent.values()) {
    if (nowMs - t < DEDUPE_MS) count++;
    if (count >= MAX_PER_WINDOW) return false;
  }
  return true;
}

function capture(level, args) {
  if (skipCapture) return;
  const message = args.map(safeStringify).join(' ');
  if (!message) return;
  if (!shouldCapture(level, message)) return;
  logService.log({ level, category: 'console', message: message.slice(0, 2000) }).catch(() => {});
}

function initConsoleCapture() {
  if (captureActive) return;
  captureActive = true;
  console.warn = function (...args) {
    skipCapture = true;
    originalConsole.warn(...args);
    skipCapture = false;
    capture('warning', args);
  };
  console.error = function (...args) {
    skipCapture = true;
    originalConsole.error(...args);
    skipCapture = false;
    capture('error', args);
  };
  console.log = function (...args) {
    originalConsole.log(...args);
  };
}

function emit(level, category, userId, message, meta) {
  const fn = level === 'error' ? originalConsole.error : level === 'warning' ? originalConsole.warn : originalConsole.log;
  fn(`[${category}]`, `[${userId || '-'}]`, message);
  logService.log({ level, category, userId, message, meta }).catch(() => {});
}

function info(category, userId, message, meta) { emit('info', category, userId, message, meta); }
function warn(category, userId, message, meta) { emit('warning', category, userId, message, meta); }
function error(category, userId, message, meta) { emit('error', category, userId, message, meta); }

module.exports = {
  initConsoleCapture,
  info,
  warn,
  error,
  log: (o) => emit(o.level || 'info', o.category || 'system', o.userId || '', o.message || '', o.meta || null),
};