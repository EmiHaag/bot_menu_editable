# Arquitectura

Estado del proyecto: migración del menú/catálogo desde Google Sheets a PostgreSQL (Neon) como fuente canónica única. Los pedidos se mantienen en Sheets.

## Diagrama general

```
                     ┌──────────────────────────────────────────┐
                     │               WHATSAPP                  │
                     └───────────────┬──────────────────────────┘
                                     ▼
                    ┌───────────────────────────────┐
                    │  app.js (startBot)            │
                    │  inyecta MenuDbService        │
                    └──────────────┬────────────────┘
                                   │
              ┌────────────────────┼───────────────────────┐
              ▼                    ▼                       ▼
   ┌──────────────────┐  ┌──────────────────┐   ┌──────────────────────┐
   │ AITranslator     │  │  MenuController  │   │    Dashboard        │
   │ Controller (IA)  │  │ (determinista)   │   │ (dashboard.js)      │
   └────────┬─────────┘  └────────┬─────────┘   └─────────┬────────────┘
            │                     │                       │
            │  buildCatalogo /   │  navegación,       CRUD del menú
            │  getNodeById /     │  carrito,          (agregar/editar/
            │  getNodesByParent  │  pedidos            borrar nodos)
            │                     │                       │
            ▼                     ▼                       ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                    MenuDbService  (adapter SQL)                     │
   │         misma interfaz que el viejo GoogleSheetsService             │
   └──────────────────────────────────┬───────────────────────────────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
   ┌────────────────────┐  ┌────────────────────┐  ┌───────────────────┐
   │   PostgreSQL (Neon)│  │   NodeCache        │  │ Pedidos: quedan   │
   │   menu_nodos       │  │   (cache 5 min)    │  │ en Sheets (sin    │
   │   bots (+nombre)   │  │   por cliente      │  │ cambios)          │
   └────────────────────┘  └────────────────────┘  └───────────────────┘

   Importación inicial (una vez):
   ┌──────────────┐   ETL app/scripts/etl_menu.js   ┌────────────────┐
   │ Google Sheets│ ───────────────────────────────▶ │  menu_nodos    │
   │ (fuente vieja)│      upsert por (comercio_id,   │                │
   └──────────────┘      node_id)                    └────────────────┘
```

## Flujo de un mensaje con IA

```
mensaje → [app.js] → AITranslatorController
                        │
                        ├── 1) _buildCatalogo: nodo actual del usuario
                        │        → MenuDbService.getNodesByParent()
                        │        → SELECT menu_nodos WHERE comercio_id + parent
                        │
                        ├── 2) _buildContexto: pedido/tema actual (StateService)
                        │
                        ▼
              IntentRouterService (clasificador LLM + Function Calling)
                        │   prompt = reglas + contexto + "CATÁLOGO REAL DEL NIVEL ACTUAL"
                        │   devuelve trigger + cantidad (validado contra el catálogo)
                        ▼
              MenuController.addItemDirect / etc. (→ MenuDbService → SQL)
```

El LLM **no cambió su lógica**, solo cambió de dónde sale la data que ve:

- El clasificador recibe el catálogo formateado en texto desde `_buildCatalogo` (lee el nodo actual del usuario y consulta `MenuDbService.getNodesByParent()` → SQL).
- Solo referencia triggers reales del catálogo; `_normalizarClasificacion` valida el trigger contra el catálogo (si no existe → `FALLO` y cae al menú estructurado).
- El contexto adicional (`_buildContexto`) sale de `StateService` (nodo actual, último tema, pedido actual).
- La acción final la ejecuta el motor determinista (`MenuController`) que también lee de SQL.

## Tablas SQL

### `menu_nodos`

Nodo plano fiel al modelo de Sheets (`Menu!A2:J`). Un producto con variantes es un nodo padre **con** precio; las hojas también usan `redirigir_a`.

| Columna               | Tipo              | Notas                                     |
| --------------------- | ----------------- | ----------------------------------------- |
| id                    | SERIAL PK         |                                           |
| comercio_id           | VARCHAR(100)      | id del cliente                            |
| node_id               | VARCHAR(100)      | clave de negocio (strings)                |
| parent_node_id        | VARCHAR(100) NULL |                                           |
| titulo                | VARCHAR(200)      |                                           |
| mensaje               | TEXT              | puede contener tags`##TAG##`            |
| trigger               | VARCHAR(50)       | códigos '0','1','2','p','v'              |
| precio                | NUMERIC(12,2)     |                                           |
| strict_trigger        | BOOLEAN           |                                           |
| redirigir_a           | VARCHAR(100) NULL |                                           |
| disponible            | BOOLEAN           |                                           |
| row_index             | INT NULL          | posición en Sheets (para respetar orden) |
| created_at/updated_at | TIMESTAMPTZ       |                                           |

Índices: `menu_nodos_pkey`, `idx_menu_nodos_uq` (comercio_id, node_id), `idx_menu_nodos_parent`, `idx_menu_nodos_comercio`, `idx_menu_nodos_busqueda` (FTS `'spanish'` sobre titulo + mensaje con tags `##...##` eliminados).

### `bots`

Se agregó la columna `nombre_negocio VARCHAR(100)`. La config (prompt, estilo, etc.) sigue en `ai_config`.

## Formato de nodo (compatibilidad)

El adapter devuelve los nodos con el **mismo formato** que Sheets para que `MenuController` y el dashboard no cambien:

- `disponible` / `strictTrigger` → strings `'true'`/`'false'` (respetan los `=== 'false'` de `menuController.js:321,446`).
- `price` → string (coma convertida a punto).
- `id` / `parentId` / `redirigirA` → strings `node_id`.
- `root` inmutable: `getMenuData()` lo crea si el cliente no tiene nodos.

## Provisión de clientes (dashboard)

- **Alta** (`create-client`): crea la fila en `bots` con `nombre_negocio`, inicializa el nodo `root`, crea el spreadsheet de pedidos y agrega el usuario.
- **Baja** (`delete-client`): borra `menu_nodos`, la fila en `bots`, la suscripción y el spreadsheet de pedidos.

## ETL (importación)

`app/scripts/etl_menu.js` lee cada spreadsheet por cliente (`GoogleSheetsService`) y hace **upsert** por `(comercio_id, node_id)` en `menu_nodos`. Idempotente.

- `node app/scripts/etl_menu.js` — upsert sin borrar ausentes.
- `node app/scripts/etl_menu.js --limpiar` — borra nodos que no están en Sheets.
- `node app/scripts/etl_menu.js --cliente=test_inmobiliaria` — solo un cliente.

## Estado de la migración

| Concepto        | Qué quedó                         |
| --------------- | ----------------------------------- |
| Menú/catálogo | Migration to`menu_nodos` (SQL)    |
| Pedidos         | Siguen en Sheets (`orderService`) |
| Config del bot  | `bots` + `ai_config`            |
| Fuente Sheets   | Solo como entrada del ETL inicial   |

## Cambios pendientes / sin commitear

- `app/src/services/menuDbService.js` — nuevo adapter SQL + `ensureMenuTables()`.
- `app/src/services/intentRouterService.js` — prompt reforzado ("ilustrativos, no exhaustivos").
- `app/src/app.js` — swap `GoogleSheetsService → MenuDbService`, hook `ensureMenuTables()` en `main()`.
- `app/src/utils/dashboard.js` — `initService` y CRUD del menú sobre SQL; eliminación del botón "Sheet"; alta/baja de clientes en SQL.
- `server.js` — registros de usuario con `spreadsheetId` vacío (el menú ya no lo necesita).
- `app/scripts/etl_menu.js` — ETL de importación.
- Deploy a Koyeb: **pendiente**. El cambio borró dependencia de Google Sheets para el menú (EDT local NO corre contra Sheets; usa Neon).
