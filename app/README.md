# WhatsApp Menu Bot (Multi-tenant & Scalable)

Este es un bot de WhatsApp modular y escalable que utiliza Google Sheets como base de datos centralizada para gestionar múltiples clientes, menús jerárquicos y autenticación de usuarios.

## Características Principales

- **Multi-tenant**: Soporta múltiples clientes (bots) con una sola instancia del servidor.
- **Gestión Dinámica**: Los usuarios y bots se configuran directamente en Google Sheets.
- **Panel de Administración Maestro**: Un panel centralizado para gestionar clientes, crear nuevos bots y asignarles sus propios Spreadsheets automáticamente.
- **Dashboard Privado por Cliente**: Cada cliente tiene acceso a su propio panel de edición sin ver los datos de otros.
- **Simulación Humana**: El bot incluye retrasos artificiales y simulación de "escribiendo" para una experiencia más natural.
- **Persistencia Avanzada**: Las sesiones de WhatsApp y de la web se mantienen incluso después de reiniciar el servidor (usando volúmenes persistentes en Koyeb).
- **Wizard de Items**: Asistente paso a paso en el dashboard para crear items de compra con cantidad, variantes y finalización.
- **Confirmación de Datos**: Al capturar datos del usuario, el bot muestra un eco de confirmación con lo ingresado.
- **Limpieza Segura de Estado**: Todos los estados intermedios del carrito se limpian correctamente incluso si ocurre un error al guardar el pedido.
- **Detección de Duplicados**: El wizard evita crear nodos "Finalizar" duplicados en una misma categoría.
- **Términos y Condiciones**: Popup obligatorio con scroll-to-approve antes de habilitar el bot QR. Registro de aprobación en Neon PostgreSQL y en Google Sheets.
- **Recuperación de Contraseña**: Flujo completo por email con tokens temporales de 15 minutos.
- **Suscripción desde Login**: Modal de suscripción al Plan Estándar directamente desde la pantalla de login.
- **Resumen de Términos visible**: Párrafo con los puntos principales de los Términos y Condiciones debajo del QR, con link al PDF completo.
- **Gestor de Turnos (Google Calendar)**: Bots tipo `TURNOS` reservan turnos vía WhatsApp integrados con Google Calendar. El cliente configura `bot_type` y `calendar_config` desde su dashboard (calendario, duración del turno, horarios de atención y preaviso mínimo). El flujo en WhatsApp es: fecha → horario disponible → nombre → confirmación, y el evento se crea en Google Calendar con registro en Neon.
- **Configuración por bot en Neon**: La tabla `bots` almacena `bot_type` (CARRITO/TURNOS) y `calendar_config` (JSONB) por cliente. La tabla `turnos` registra los eventos creados en Google Calendar.

## Configuración de Google Sheets

El Spreadsheet principal debe contener al menos dos pestañas:

### 1. Pestaña `Usuarios` (Control de Acceso y Gestión)
Gestiona quién puede entrar al dashboard y qué bots deben iniciarse.

| id_cliente | nombre_cliente | activo | user | password | fecha_suscripcion | spreadsheetId | email | fecha_terminos |
|------------|----------------|--------|------|----------|-------------------|---------------|-------|----------------|
| cliente_1  | Mi Tienda      | TRUE   | user1| pass456  | 07/05/2024        | [ID_OPCIONAL] | mail@ | 24/06/2026 |

*   **id_cliente**: Identificador único.
*   **activo**: Debe ser `TRUE` para que el bot de ese cliente se inicie.
*   **spreadsheetId**: (Opcional) ID de un Google Sheet específico para ese cliente. Si está vacío, usa el general configurado en las variables de entorno.
*   **email**: Email del usuario (se guarda automáticamente al crear la suscripción).
*   **fecha_terminos**: Fecha en que el usuario aceptó los Términos y Condiciones (se guarda automáticamente).

Los encabezados se crean/actualizan automáticamente al iniciar el servidor o al agregar un usuario.

### 2. Pestaña `Menu` (Estructura del Bot)
Define el árbol de navegación de los mensajes.

| ID_client | ID | ParentID | Title | Message | Trigger |
|-----------|----|----------|-------|---------|---------|
| cliente_1 | 1  | root     | Soporte | ¿En qué fallamos? | 1 |
| cliente_1 | 1_1| 1        | Internet | Revisa tu modem. | 1 |

*   **ID_client**: Debe coincidir con el `id_cliente` de la pestaña Usuarios.
*   **Trigger**: El número o letra que el usuario debe escribir para elegir la opción.

## Dashboard y Gestión

- **Login Maestro (Admin)**: Entra con las credenciales `ADMIN_USER` y `ADMIN_PASS` configuradas en el entorno. Permite crear nuevos clientes y ver todos los bots activos.
- **Dashboard de Cliente**: Los clientes solo ven y editan sus propias filas.
- **Estado de WhatsApp (QR)**: Panel dinámico para vincular dispositivos. Incluye auto-limpieza de recursos y detección de inactividad para ahorrar memoria.
- **Términos y Condiciones**: Al entrar a la sección QR, si el usuario no aceptó los Términos, se muestra un popup obligatorio. El botón "Aprobar" se habilita solo después de hacer scroll hasta el final del texto. La aprobación se registra en Neon PostgreSQL y en la planilla Google Sheets.
- **Recuperación de Contraseña**: Link "¿Olvidaste tu contraseña?" en el login. Solicita email, envía link con token de 15 minutos, formulario para nueva contraseña.
- **Suscripción desde Login**: Link "Aún no tenés usuario?" en el login que abre el modal de suscripción al Plan Estándar (mismo flujo MercadoPago que desde el index público).

## Gestor de Turnos (Google Calendar)

El bot puede actuar como **gestor de turnos** en lugar de carrito. Para habilitarlo:

1. **Configurar el calendario en el dashboard** (sección Configuración del bot):
   - `bot_type` = `TURNOS`
   - `calendar_id` = ID del calendario de Google donde se crean los turnos
   - `slot_duration_minutes` = duración de cada turno (ej. 30)
   - `business_hours` = franjas horarias por día de la semana (`'0'`=Domingo ... `'6'`=Sábado), formato `[{ desde: '09:00', hasta: '18:00' }]`
   - `min_notice_hours` = antelación mínima de reserva en horas
   - Se puede probar la disponibilidad con el botón de vista previa antes de guardar.

2. **Agregar el nodo `##TURNO##`** en el menú: en el editor visual, cualquier nodo cuyo `Message` contenga `##TURNO##` inicia el flujo de reserva.

3. **Re-autorizar OAuth con scope Calendar** (ver sección Autenticación Google arriba).

### Flujo en WhatsApp
1. El usuario elige el nodo con `##TURNO##` y se le pide la fecha (`25/12` o `25/12/2026`; también `hoy` o `mañana`).
2. El bot consulta disponibilidad (freebusy) y muestra los horarios libres numerados.
3. El usuario elige un horario y escribe su nombre.
4. Se muestra el resumen: Fecha, Hora y Nombre. Con `1` confirma, con `2` cancela.
5. Al confirmar se crea el evento en Google Calendar (`summary: Turno <nombre>`) y se registra en la tabla `turnos` de Neon.

En cualquier paso, `v` vuelve al paso anterior y `0` vuelve al menú principal. Si `bot_type` no es `TURNOS` o falta `calendar_id`, el nodo muestra un mensaje de servicio no configurado.

## Requisitos e Instalación (Producción/Koyeb)

Para desplegar en Koyeb, es necesario configurar las siguientes variables de entorno:

### Variables de Servidor y Admin
- **`PORT`**: 8000
- **`SPREADSHEET_ID`**: ID del Google Sheet principal.
- **`ADMIN_USER` / `ADMIN_PASS`**: Credenciales para el acceso maestro (`/admin`).
- **`SESSION_SECRET`**: Clave para la seguridad de las sesiones web.
- **`AUTH_SESSIONS_DIR`**: Debe ser `/data/auth_sessions` para usar volúmenes persistentes.

### Autenticación Google (OAuth2)
El sistema utiliza el flujo OAuth2 para que el bot actúe en nombre de tu cuenta personal:
- **`OAUTH_CREDENTIALS_CONTENT`**: Contenido JSON de tus credenciales de cliente OAuth.
- **`OAUTH_TOKEN_CONTENT`**: Contenido JSON del token de acceso (incluyendo el `refresh_token`).

> **Importante**: Para el Gestor de Turnos el token debe incluir el scope `https://www.googleapis.com/auth/calendar` además de `spreadsheets` y `drive`. Si el token actual no lo tiene, re-autorizá con `node auth_calendar.js` (sirve un mini-servidor en `http://localhost:3000` para capturar el code) y actualizá `OAUTH_TOKEN_CONTENT` en Koyeb.

### Neon PostgreSQL (Términos y Condiciones)
- **`NEON_DATABASE_URL`**: URL de conexión a Neon PostgreSQL. Se usa para almacenar los registros de aprobación de Términos y Condiciones, la configuración de cada bot (`bots`) y los turnos reservados (`turnos`). Las tablas se crean automáticamente al iniciar el servidor.

Ejemplo:
```
NEON_DATABASE_URL=postgresql://neondb_owner:<password>@<endpoint>.neon.tech/<dbname>?sslmode=require
```

### Email (SMTP)
- **`SMTP_HOST`**, **`SMTP_PORT`**, **`SMTP_SECURE`**, **`SMTP_USER`**, **`SMTP_PASS`**: Configuración del servidor SMTP para envío de emails (bienvenida y recuperación de contraseña).

### MercadoPago
- **`MERCADOPAGO_ACCESS_TOKEN`**: Token de acceso de MercadoPago para gestionar suscripciones.
- **`SITE_URL`**: URL pública del sitio (necesaria para callbacks de MercadoPago y links de recuperación de contraseña).

### Cloudflare Turnstile (Anti-bot)
- **`TURNSTILE_SITE_KEY`** / **`TURNSTILE_SECRET_KEY`**: Protección anti-bot en el login.

### Otros
- **`BOT_PHONE`**: Número de WhatsApp del bot.
- **`PRECIO_ESTANDAR`**: Precio del plan estándar (se muestra en el modal de suscripción).
- **`BOT_HELPER_GOOGLE_AI_KEY`**: API key de Google Gemini AI para el asistente integrado.

## Persistencia en Koyeb
Es fundamental configurar un **Volumen Persistente** montado en la ruta `/data`. Esto asegura que:
1. No tengas que escanear el código QR cada vez que la app se reinicia.
2. Tu sesión en el Dashboard no se cierre inesperadamente tras un despliegue.

## Endpoints API

### Públicos (sin auth)
- `GET /app/login` - Página de login (incluye modal de suscripción y recuperación de contraseña)
- `POST /app/login` - Autenticación
- `GET /app/logout` - Cierre de sesión
- `GET /app/reset-password?token=xxx` - Formulario de nueva contraseña
- `POST /app/reset-password` - Actualiza contraseña con token
- `POST /app/api/password-reset/request` - Solicita email de recuperación

### Protegidas (requieren sesión)
- `GET /app/` - Dashboard principal
- `GET /app/qr` - Panel de estado QR del bot
- `GET /app/api/bot/status/:id` - Estado actual de un bot
- `POST /app/api/bot/start/:id` - Iniciar conexión WhatsApp
- `POST /app/api/bot/stop/:id` - Detener conexión
- `GET /app/api/terms/status/:userId` - Verificar si aceptó Términos
- `POST /app/api/terms/approve` - Registrar aceptación de Términos
- `GET /app/api/bot-config?botId=xxx` - Obtener `bot_type` y `calendar_config` del bot
- `POST /app/api/bot-config` - Guardar `bot_type` y `calendar_config`
- `GET /app/api/bot-config/disponibilidad?fecha=YYYY-MM-DD` - Vista previa de horarios libres de un calendario

## Estructura del Proyecto

- `app/src/app.js`: Orquestador de bots, rutas de login, QR, Términos y recuperación de contraseña.
- `app/src/services/userService.js`: Gestión de usuarios, auth, email, fecha_terminos (Google Sheets).
- `app/src/services/googleSheetsService.js`: Cliente de Sheets y filtrado por cliente.
- `app/src/services/googleDriveService.js`: Creación automática de Sheets para nuevos clientes.
- `app/src/services/stateService.js`: Gestión de estado en memoria (carrito, datos, pendientes).
- `app/src/services/orderService.js`: Persistencia de pedidos completados en Google Sheets.
- `app/src/services/emailService.js`: Envío de emails (bienvenida, recuperación de contraseña).
- `app/src/services/termsService.js`: Gestión de aprobación de Términos y Condiciones en Neon PostgreSQL.
- `app/src/services/mercadoPagoService.js`: Integración con MercadoPago para suscripciones.
- `app/src/services/botConfigService.js`: Configuración por bot (`bots`) y registro de turnos (`turnos`) en Neon PostgreSQL.
- `app/src/services/googleCalendarService.js`: Disponibilidad (freebusy), alta/edición/cancelación de eventos en Google Calendar.
- `app/src/services/googleAuthBase.js`: Cliente OAuth2 compartido (Sheets/Drive/Calendar) con soporte ENV + archivo local.
- `auth_calendar.js`: Script de re-autorización OAuth con scopes de Sheets + Drive + Calendar (mini-servidor en `localhost:3000`).
- `app/src/controllers/menuController.js`: Lógica de navegación con WhatsApp (wizard, carrito, checkout, turnos).
- `app/src/utils/dashboard.js`: Servidor Express para el panel de administración web (editor visual + wizard).
- `app/src/utils/helpGuide.js`: Guía de ayuda interactiva embebida en el dashboard.
- `app/src/utils/geminiHelper.js`: Asistente IA integrado en el dashboard.
- `public/index.html`: Landing page pública con planes, demo y modal de suscripción.
- `public/pago_exitoso.html`: Página de redirección post-pago.
- `public/terminos_condiciones/`: PDF con los Términos y Condiciones completos.
