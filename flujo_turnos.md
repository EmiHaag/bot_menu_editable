# Flujo de Turnos: Recordatorios, Confirmar/Cancelar, "Mis Turnos" y Lista de Espera

> Documento de referencia del sistema de gestión de turnos del Bot Menu.
> Pensado para ser entendido en el futuro por cualquier desarrollador (o por mi misma) sin tener que leer todo el código.

---

## 1. Dónde vive la lógica hoy

La lógica de agendado de turnos está en `app/src/controllers/menuController.js` (líneas ~580-793):

| Función | Rol |
|---|---|
| `_iniciarReserva` | Inicia el flujo: pide la fecha al usuario |
| `_handleTurnoDate` | Valida la fecha y muestra los horarios disponibles |
| `_handleTurnoSlot` | Elige el horario y pide el nombre |
| `_handleTurnoConfirm` | Muestra el resumen y confirma la reserva (crea el evento en Google Calendar) |

El flujo se enruta desde `handleIncomingMessage` en función del estado del usuario
(`stateService.getWaitingTurnoDate/Slot/Confirm`).

**¿Tenemos acceso al teléfono del usuario?** Sí.
- El `jid` = `msg.key.remoteJid` (ej: `54911...@s.whatsapp.net`) contiene el número completo.
- Se guarda en la tabla `turnos.cliente_telefono` al registrar el turno.
- Para enviar mensajes proactivos (recordatorios) alcanza con `botQRs[id].sock.sendMessage(jid, ...)`.
  El `sock` de cada bot está en `app.js` (`botQRs[id].sock`) y cada bot conectado corre su propio loop.

**Persistencia actual:**
- Tabla `turnos`: `google_event_id, id_cliente, cliente_telefono, cliente_nombre, fecha_inicio, fecha_fin, estado`.
- Config por bot: JSON `calendar_config` en la tabla `bots` (cargado por `getBotConfig`, guardado por `saveBotConfig`).
- Dashboard: HTML en `app/src/utils/dashboard.js` (~1764-1822) + JS `loadBotConfig`/`saveBotTypeConfig` (~2486-2609).

**No existía** infraestructura previa de recordatorios, scheduler ni lista de espera.

---

## 2. A considerar: el tipo de bot puede cambiar y afecta a los recordatorios

**AVISO IMPORTANTE:** el motor de recordatorios (cron) busca turnos únicamente en los bots cuyo
`bot_type === 'TURNOS'`. Si el usuario **cambia el tipo de bot** desde el dashboard (sección
"Configuración de Google Calendar / tipo de bot"), el cron dejará de procesar sus turnos.

- Si tiene un menú de turnos y cambia a otro tipo (p. ej. `CARRITO`, `FAQ`), los recordatorios,
  la confirmación, "mis turnos" y la lista de espera **se desactivan** para ese bot.
- Advertencia a mostrar en el dashboard: al cambiar `bot_type` de un bot que tiene turnos activos,
  informar al usuario que puede afectar a los recordatorios ya programados.
- Recomendado: al hacer el cambio, dejarlo registrado en los logs (p. ej. en `logService`) y, si es
  posible, avisar por el propio chat del bot.

> Diseño actual: el cron itera `botQRs` filtrando por `bot_type === 'TURNOS'`. Por eso, cambiar el
> tipo rompe el recordatorio. Alternativa futura si se quiere robustez: guardar el tipo de bot en
> cada turno (o en `bots`) y que el cron consulte por `id_cliente` consultando turnos activos
> independientemente del tipo actual. Ver sección 9 (mejoras futuras).

---

## 3. Cambios de base de datos (`botConfigService.js`)

### 3.1. Ampliar tabla `turnos`
Usar `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (no romper instalaciones existentes):

- `estado` — ya existe. Valores a usar:
  - `activo` — turno recién creado, aún sin recordatorio.
  - `recordado` — se envió el recordatorio, esperando respuesta (confirmar/cancelar).
  - `confirmado` — el usuario confirmó (vía recordatorio o "mis turnos").
  - `cancelado` — el usuario canceló o fue liberado.
- `recordatorio_enviado BOOLEAN DEFAULT false` — evita reenviar el recordatorio.

### 3.2. Nueva tabla `lista_espera`
```
id SERIAL PRIMARY KEY
id_cliente VARCHAR(100)
fecha_inicio TIMESTAMPTZ        -- slot EXACTO al que el usuario quiere entrar
cliente_telefono VARCHAR(100)
cliente_nombre TEXT
estado VARCHAR(20) DEFAULT 'esperando'   -- 'esperando' | 'ofrecido' | 'aceptado' | 'descartado'
created_at TIMESTAMPTZ DEFAULT NOW()
```
Guardar el **slot exacto** (`fecha_inicio`) es clave para el aviso en cascada.

### 3.3. Métodos nuevos (exports de `botConfigService`)
- `registrarEnListaEspera({ idCliente, fechaInicio, clienteTelefono, clienteNombre })`
- `getListaEsperaParaSlot(idCliente, fechaInicio)` — ordenada por `created_at ASC`
- `marcarEstadoListaEspera(id, estado)`
- `marcarRecordatorioEnviado(googleEventId)`
- `actualizarEstadoTurno(googleEventId, estado)`
- `getTurnosARecordar(idCliente, horasAntes)` — turnos con `estado='activo'`, `recordatorio_enviado=false`
  y `fecha_inicio - now <= horasAntes`

### 3.4. Defaults de config
En `DEFAULT_CALENDAR_CONFIG` agregar:
- `reminder_enabled` (bool)
- `reminder_hours_before` (2 o 24)
- `waitlist_enabled` (bool)

---

## 4. Motor de recordatorios / scheduler

**Nuevo archivo:** `app/src/services/reminderService.js`

- Un `setInterval` **cada 60 minutos** (bajo uso de CPU, sin dependencias nuevas).
- Itera los bots conectados y filtra `bot_type === 'TURNOS'`. **Ver aviso de la sección 2.**
- Para cada bot: `getTurnosARecordar(idCliente, horasAntes)` y envía recordatorios.
- **Ventana de no-molestar 8:00 – 22:00 (hora Argentina):** solo envía si la hora actual cae en el
  rango. Si no, reintenta en el próximo tick (best-effort dada la granularidad de 60 min).
- Al enviar: `sock.sendMessage(jid, ...)` + `estado='recordado'` + `recordatorio_enviado=true` +
  setear `WaitingTurnoReminder` para capturar la respuesta 1/2.

**Arranque/parada:** en `app.js`, iniciar el reminderService por bot conectado y detenerlo cuando el
bot se desconecte (para no gastar CPU en bots apagados).

---

## 5. Confirmar / cancelar desde el recordatorio (`menuController.js`)

- Nuevo estado `WaitingTurnoReminder` (ver `stateService.js`).
- Nuevo handler `_handleTurnoReminder(sock, jid, text)`:
  - **1 = Confirmar** → `actualizarEstadoTurno('confirmado')` + mensaje de confirmación.
  - **2 = Cancelar** → `cancelarTurno` (Google Calendar) + `actualizarEstadoTurno('cancelado')`
    + **disparar la cascada de lista de espera** del slot liberado.
- Registrar la ruta en `handleIncomingMessage` con prioridad (igual que los estados de turno actuales).

---

## 6. Opción "Mis turnos"

- Nuevo nodo/tag de menú `##MISTURNOS##` (recomendado) o texto libre "mis turnos".
- Muestra el/los turno(s) del usuario consultando `turnos` por `cliente_telefono = jid` y `estado != 'cancelado'`.
- Opciones por turno:
  - **1 = Aceptar / Confirmar**
  - **2 = Cancelar** → libera el slot → dispara la cascada de lista de espera.
- Reutiliza la misma lógica de confirmar/cancelar que el recordatorio.

---

## 7. Lista de espera con slots "tachados"

### 7.1. Mostrar horarios ocupados pero "solicitar si cancela"
- En `_handleTurnoDate`, los horarios **ocupados se muestran igualmente pero tachados/grises**
  con "(solicitar si cancela)".
- Para saber cuáles están ocupados por slot:
  - Extender `consultarDisponibilidad` (o agregar `consultarDisponibilidadConOcupados` en
    `googleCalendarService.js`) para que además de los libres retorne los rangos ocupados del freebusy.
  - (Opción alternativa/refuerzo: deducir ocupados por este bot desde la tabla `turnos`.)

### 7.2. Anotarse en la cola
- Si el usuario elige un slot tachado (o escribe su número): `registrarEnListaEspera(...)` con el
  `fecha_inicio` exacto y confirmar que quedó en espera.
- Solo disponible si `waitlist_enabled === true`.

### 7.3. Cascada al liberarse un slot
Al cancelarse un turno (`fecha_inicio` del slot liberado):
1. `getListaEsperaParaSlot(idCliente, fechaInicio)` ordenada por `created_at`.
2. Ofrecer al primero (`estado='ofrecido'`): "Se liberó tu horario, ¿lo querés? 1=Confirmar 2=Pasar".
3. Si **confirma** → crear evento en Google Calendar (`agendarTurno`) + `registrarTurno`
   + marcar la cola como `aceptado` → fin.
4. Si **rechaza / no responde en tiempo** → `descartado` y pasar al siguiente de la cola.
5. Repetir hasta que uno confirme o se agote la cola.

---

## 8. Configuración en el dashboard

En la sección "Configuración de Google Calendar" (`app/src/utils/dashboard.js`, tras `minNoticeInput` ~1797):

- **Recordatorio**
  - Checkbox `reminder_enabled` (activa recordatorios).
  - Selector `reminder_hours_before` con opciones **2 hs** y **24 hs**.
- **Lista de espera**
  - Checkbox `waitlist_enabled` (activa la oferta en slots tachados y la cascada).

En el JS:
- `loadBotConfig` (~2564-2573): cargar los nuevos campos.
- `saveBotTypeConfig` (~2588-2594): incluir los nuevos campos en el payload de `calendar_config`.
- Al cambiar `bot_type` de un bot con turnos activos, **advertir al usuario** (sección 2):
  "Si tu bot es de turnos y cambiás de tipo, los recordatorios y la lista de espera dejarán de funcionar."

---

## 9. Mejoras futuras (no implementadas)

- **Robustez ante cambio de tipo de bot:** guardar el tipo de bot en cada turno (o en `bots`) y que
  el cron consulte turnos activos por `id_cliente` sin depender del `bot_type` actual. Esto eliminaría
  la limitación de la sección 2.
- **Ventana de no-molestar configurable** por bot (hoy fija 8–22 Argentina).
- **Reminder con distinta granularidad** (p. ej. correr cada 15/30 min) para acertar más finito la
  ventana de 2 hs respetando la no-molestia.
- **Timeout expirable** en la cascada de lista de espera (definir cuánto tiempo espera la respuesta
  antes de pasar al siguiente).

---

## 10. Archivos a tocar (resumen)

| Archivo | Cambio |
|---|---|
| `app/src/services/botConfigService.js` | Schema turnos + tabla lista_espera + métodos CRUD + defaults config |
| `app/src/services/reminderService.js` | **Nuevo** — scheduler 60 min + envío con no-molestar |
| `app/src/app.js` | Arrancar/parar reminderService por bot conectado |
| `app/src/controllers/menuController.js` | Slots tachados, estado recordatorio, "mis turnos", cascada waitlist |
| `app/src/services/googleCalendarService.js` | Devolver ocupados + reusar agendar/cancelar |
| `app/src/services/stateService.js` | Estado `WaitingTurnoReminder` |
| `app/src/utils/dashboard.js` | Campos config + carga/guardado + aviso de cambio de tipo |
| `app/src/utils/icons.js` | Iconos si hicieran falta |

---

## 11. Verificación

- Flujo con bot en `TURNOS`: agendar → correr scheduler → recordatorio → confirmar/cancelar
  → liberar slot → ofrecer al primero de la cola.
- Confirmar no-molestar 8–22.
- `npm start` sin errores; revisar logs.
- Probar cambio de `bot_type` y verificar que se advierte y se desactivan recordatorios (sección 2).
