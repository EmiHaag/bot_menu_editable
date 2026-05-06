# WhatsApp Menu Bot (Modular & Multi-Bot Architecture)

Este es un bot de WhatsApp altamente modular y escalable que utiliza Google Sheets como fuente de verdad única. La arquitectura permite ejecutar múltiples bots de WhatsApp simultáneamente desde una sola instancia, con gestión de estados independiente y un dashboard unificado.

## Características Principales

- **Multi-Bot:** Ejecuta varios bots con diferentes números y configuraciones en paralelo.
- **Google Sheets como CMS:** Administra menús, respuestas y flujos jerárquicos desde una hoja de cálculo.
- **Multi-Tenant:** Usa la columna `ID_client` para separar los menús de diferentes bots en el mismo Sheet.
- **Dashboard de Gestión:** Interfaz web para visualizar la estructura del menú, editar nodos, agregar hijos y limpiar caché.
- **Navegación Inteligente:** Soporte nativo para niveles de profundidad (3-4 niveles), volver atrás (9) y volver al inicio (0).

## Estructura de Google Sheets

La hoja de cálculo debe tener una pestaña llamada `Menu` con las siguientes columnas:

| ID_client | ID | ParentID | Title | Message | Trigger |
|-----------|----|----------|-------|---------|---------|
| default   | 1  | root     | Soporte | ¿En qué te ayudamos? | 1 |
| default   | 1_1| 1        | Internet| Elige tu plan: | 1 |
| cliente_2 | root| none     | Inicio | Bienvenida Cliente 2 | 0 |

- **ID_client:** Identificador del bot (definido en `src/config/bots.js`). Si se usa `default`, el bot leerá los nodos con ese ID o vacíos para mantener compatibilidad.
- **ID:** Identificador único del nodo.
- **ParentID:** ID del nodo padre (`root` para el menú principal).
- **Trigger:** Tecla o palabra que activa la opción.

## Configuración

1. **Clonar el repositorio.**
2. **Instalar dependencias:** `npm install`.
3. **Variables de Entorno (.env):**
   ```env
   SPREADSHEET_ID=tu_id_de_sheet
   CREDENTIALS_JSON={...tu_json_de_google_service_account...}
   CLIENT_ID=default
   ```
4. **Configuración de Bots (`src/config/bots.js`):**
   Define aquí tus instancias:
   ```javascript
   const bots = [
       {
           id: 'default',
           spreadsheetId: process.env.SPREADSHEET_ID,
           credentials: process.env.CREDENTIALS_JSON,
           authFolder: 'auth_info_baileys'
       }
       // Agrega más bots aquí
   ];
   ```

## Ejecución

```bash
npm start
```

Escanea el código QR en la terminal para cada bot que inicies.

## Dashboard

Accede a `http://localhost:3000` para:
- Seleccionar entre diferentes bots configurados.
- Visualizar la estructura jerárquica (Árbol).
- Editar mensajes y opciones en tiempo real.
- Refrescar el caché para aplicar cambios del Sheet inmediatamente.

## Arquitectura Modular

- **`src/services/googleSheetsService.js`**: Cliente instantiable para Sheets con caché inteligente por cliente.
- **`src/services/stateService.js`**: Gestión de sesiones y estados de usuario aislada por bot.
- **`src/controllers/menuController.js`**: Lógica de navegación desacoplada.
- **`src/utils/dashboard.js`**: Interfaz de administración multi-bot.
- **`src/app.js`**: Orquestador de conexiones Baileys.
