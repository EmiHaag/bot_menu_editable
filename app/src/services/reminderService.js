const INTERVAL_MS = 10 * 60 * 1000; // cada 10 min

const bots = new Map();

/**
 * Inicia el scheduler de recordatorios para un bot conectado.
 * Llama a menuController.procesarRecordatorios(sock) en cada tick.
 */
function startBot(id, { sock, menuController }) {
    stopBot(id);
    const timer = setInterval(async () => {
        try {
            if (!sock || !sock.user) return; // solo si el bot sigue conectado
            await menuController.procesarRecordatorios(sock);
        } catch (err) {
            console.error(`[Reminder] Error procesando recordatorios del bot ${id}:`, err && err.message);
        }
    }, INTERVAL_MS);
    bots.set(id, { timer, sock, menuController });
}

function stopBot(id) {
    const entry = bots.get(id);
    if (entry) {
        clearInterval(entry.timer);
        bots.delete(id);
    }
}

function isRunning(id) {
    return bots.has(id);
}

module.exports = {
    startBot,
    stopBot,
    isRunning,
    INTERVAL_MS
};
