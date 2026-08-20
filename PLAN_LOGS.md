# PLAN: Logs en tiempo real (sin base de datos)

> Documento de continuidad: si se corta la sesión, retomar desde acá.

## Objetivo
Quitar `system_logs` y `user_events` de la base de datos (sobrecarga a Neon).
Mostrar logs/eventos en tiempo real **cada 10 segundos**, solo mientras el
usuario **admin** está en esa pantalla. Todo en memoria (RAM), nada en DB.

## Decisión de diseño
- `logService.js` pasa a ser un **ring buffer en memoria** (arrays).
- Se mantiene la MISMA API exportada (`log`, `track`, `getLogs`, `getEvents`,
  `getLogUsers`, `getEventUsers`, `getEventActions`, `ensureTable`,
  `startCleanup`) para no romper `logger.js`, `dashboard.js` y `app.js`.
- `ensureTable()` y `startCleanup()` quedan como **no-ops** (compatibilidad).
- El frontend admin (2 pantallas) polléa cada 10s y pausa si la pestaña está
  oculta (via `document.visibilitychange`).

## Estado de implementación

### DONE ✅
1. **`app/src/services/logService.js`** — REESCRITO completo a memoria:
   - `log()` y `track()` hacen `unshift` a `logs[]` / `events[]` con
     `created_at` en ISO. Cap: MAX_LOGS=1000, MAX_EVENTS=500.
   - `getLogs/getEvents/getLogUsers/getEventUsers/getEventActions` filtran
     desde RAM (misma forma de filtros que antes: level/category/userId/search,
     userId/action/search).
   - Eliminados: neon, `sql`, batch queue/flush, `flushOnExit`, `cleanupOld`,
     `startCleanup` real, escrituras `INSERT`, tablas e índices.
   - `ensureTable()` y `startCleanup()` = no-op.

2. **`app/src/utils/dashboard.js`** — Visor de LOGS (`/app/admin/logs`):
   - Polling cambiado de `setInterval(loadLogs, 15000)` → `10000`.
   - Agregado manejo de `visibilitychange`: si la pestaña se oculta, el
     intervalo sigue (pero al volver visible hace `loadLogs()` y reinicia el
     timer). (Se puede mejorar pausando el timer al ocultarse.)

### PENDIENTE ⏳
3. **`app/src/utils/dashboard.js`** — Visor de EVENTOS (`/app/admin/events`):
   - Mismo cambio que el visor de logs: polling 15000 → 10000 + `visibilitychange`.
   - ✅ HECHO (mismo patrón que el visor de logs).

4. **`app/src/app.js`** — ✅ HECHO: quitadas las llamadas a
   `logService.ensureTable()` y `logService.startCleanup()` del `main()`
   (antes líneas 1006-1007). El require de `logService` se mantiene porque
   aún se usa `logService.track()` (auth login/logout, bot iniciado).

5. **`app/src/utils/logger.js`** — Sin cambios necesarios (sigue llamando
   `logService.log()`, ahora en memoria). ✅ Verificado: no hay referencias
   a funciones eliminadas.

## Verificación (comandos)
- `node --check app/src/services/logService.js`
- `node --check app/src/utils/dashboard.js`
- `node --check app/src/utils/logger.js`
- `node --check app/src/app.js`
- Arrancar app: `node server.js` (o como corresponda) y entrar a
  `/app/admin/logs` y `/app/admin/events` como admin → deben refrescar cada 10s
  sin tocar la DB.
- Confirmar que NO hay más queries a `system_logs` / `user_events`:
  `grep -ri "system_logs\|user_events" app/src/`

## Notas / contexto extra
- El emoji→Heroicons ya está hecho (no tocar).
- `.gitignore` ahora ignora `app/FACTURACION_ARCA.md` (se sacó del índice).
- Muchos archivos modificados sin commitear (trabajo previo de la sesión).
- El bot de WhatsApp (menuController.js) conserva sus emojis (por diseño).