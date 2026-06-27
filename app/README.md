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

## Configuración de Google Sheets

El Spreadsheet principal debe contener al menos dos pestañas:

### 1. Pestaña `Usuarios` (Control de Acceso y Gestión)
Gestiona quién puede entrar al dashboard y qué bots deben iniciarse.

| id_cliente | nombre_cliente | activo | user | password | fecha_suscripcion | spreadsheetId |
|------------|----------------|--------|------|----------|-------------------|---------------|
| cliente_1  | Mi Tienda      | TRUE   | user1| pass456  | 2024-05-07        | [ID_OPCIONAL] |

*   **id_cliente**: Identificador único.
*   **activo**: Debe ser `TRUE` para que el bot de ese cliente se inicie.
*   **spreadsheetId**: (Opcional) ID de un Google Sheet específico para ese cliente. Si está vacío, usa el general configurado en las variables de entorno.

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

## Persistencia en Koyeb
Es fundamental configurar un **Volumen Persistente** montado en la ruta `/data`. Esto asegura que:
1. No tengas que escanear el código QR cada vez que la app se reinicia.
2. Tu sesión en el Dashboard no se cierre inesperadamente tras un despliegue.

## Estructura del Proyecto

- `src/services/userService.js`: Gestión de usuarios y auth (incluye el usuario admin virtual).
- `src/services/googleSheetsService.js`: Cliente de Sheets y filtrado por cliente.
- `src/services/googleDriveService.js`: Creación automática de Sheets para nuevos clientes.
- `src/services/stateService.js`: Gestión de estado en memoria (carrito, datos, pendientes).
- `src/services/orderService.js`: Persistencia de pedidos completados en Google Sheets.
- `src/controllers/menuController.js`: Lógica de navegación con WhatsApp (wizard, carrito, checkout).
- `src/utils/dashboard.js`: Servidor Express para el panel de administración web (editor visual + wizard).
- `src/utils/helpGuide.js`: Guía de ayuda interactiva embebida en el dashboard.
- `src/utils/geminiHelper.js`: Asistente IA integrado en el dashboard.
- `src/app.js`: Orquestador de bots dinámicos y punto de entrada.
- `documentacion.txt`: Guía completa del editor de menú para el usuario final.
