# WhatsApp Menu Bot (Multi-tenant & Scalable)

Este es un bot de WhatsApp modular y escalable que utiliza Google Sheets como base de datos centralizada para gestionar múltiples clientes, menús jerárquicos y autenticación de usuarios.

## Características Principales

- **Multi-tenant**: Soporta múltiples clientes (bots) con una sola instancia del servidor.
- **Gestión Dinámica**: Los usuarios y bots se configuran directamente en Google Sheets.
- **Dashboard Privado**: Cada cliente tiene acceso a su propio panel de edición sin ver los datos de otros.
- **Simulación Humana**: El bot incluye retrasos artificiales y simulación de "escribiendo" para una experiencia más natural.
- **Caché Inteligente**: Utiliza caché en memoria para minimizar las llamadas a la API de Google Sheets.

## Configuración de Google Sheets

El Spreadsheet debe contener al menos dos pestañas principales:

### 1. Pestaña `Usuarios` (Control de Acceso y Bots)
Gestiona quién puede entrar al dashboard y qué bots deben iniciarse.

| id_cliente | nombre_cliente | activo | user | password | fecha_suscripcion |
|------------|----------------|--------|------|----------|-------------------|
| admin      | Administrador  | TRUE   | admin| clave123 | 2024-05-07        |
| cliente_1  | Mi Tienda      | TRUE   | user1| pass456  | 2024-05-07        |

*   **id_cliente**: Identificador único (el ID `admin` tiene permisos totales).
*   **activo**: Debe ser `TRUE` para que el bot de ese cliente se inicie automáticamente.
*   **user/password**: Credenciales para acceder al Dashboard.

### 2. Pestaña `Menu` (Estructura del Bot)
Define el árbol de navegación de los mensajes.

| ID_client | ID | ParentID | Title | Message | Trigger |
|-----------|----|----------|-------|---------|---------|
| cliente_1 | 1  | root     | Soporte | ¿En qué fallamos? | 1 |
| cliente_1 | 1_1| 1        | Internet | Revisa tu modem. | 1 |

*   **ID_client**: Debe coincidir con el `id_cliente` de la pestaña Usuarios.
*   **Trigger**: El número o letra que el usuario debe escribir para elegir la opción.

## Dashboard y QR

- **Dashboard Principal**: `http://localhost:8000/`
    - Los clientes solo ven y editan sus propias filas.
    - El administrador puede alternar entre todos los clientes activos.
- **Estado de WhatsApp (QR)**: `http://localhost:8000/qr`
    - Panel dinámico para vincular dispositivos sin refrescos de página.
    - Generación de QR bajo demanda y auto-limpieza de recursos.

## Optimización de Recursos y Gestión de QR

Para maximizar la eficiencia y minimizar el consumo de memoria, el sistema implementa una gestión inteligente de conexiones:

- **Carga Bajo Demanda**: Los bots que no tienen una sesión activa no se conectan automáticamente al iniciar el servidor. Solo se activan cuando el usuario lo solicita manualmente.
- **Lazy QR Generation**: El código QR solo se convierte a imagen (Base64) si hay un usuario visualizando activamente el panel de control.
- **Timeout de Escaneo**: Una vez generado el QR, el sistema otorga **30 segundos** para ser escaneado. Si no hay éxito, la conexión se cierra automáticamente.
- **Gestión de Visibilidad**: Si la pestaña del navegador se oculta, se minimiza o se cierra, el bot en espera de QR se **detiene inmediatamente** para liberar recursos.
- **Auto-apagado por Inactividad**: Si no se detecta actividad en la página `/qr` durante 45 segundos, el servidor finaliza los procesos de conexión pendientes.

## Requisitos e Instalación

1.  **Node.js v16+**.
2.  **Google Service Account**: Generar credenciales JSON y dar acceso al Spreadsheet.
3.  **Variables de Entorno (.env)**:
    ```env
    PORT=8000
    SPREADSHEET_ID=tu_id_de_google_sheets
    CREDENTIALS_JSON={"type": "service_account", ...}
    ```
4.  **Instalar dependencias**: `npm install`.
5.  **Ejecutar**: `npm start` o `node src/app.js`.

## Estructura del Proyecto

- `src/services/userService.js`: Gestión de usuarios y auth desde Google Sheets.
- `src/services/googleSheetsService.js`: Cliente de Sheets y filtrado por cliente.
- `src/controllers/menuController.js`: Lógica de navegación con delays y typing.
- `src/utils/dashboard.js`: Servidor Express para el panel de administración web.
- `src/app.js`: Orquestador de bots dinámicos y punto de entrada.
