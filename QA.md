# QA y Testing Automatizado — WA Menu

Este documento explica, en palabras claras y sin rodeos, cómo funciona el sistema de
pruebas automáticas de WA Menu. Hay **tres piezas** que trabajan juntas:

| Pieza | Comando | Qué hace en una frase |
|---|---|---|
| **QA Runner** | `npm run test:smart` | Revisa que el **servidor web** funcione (probando sus rutas por internet local). |
| **LLM Benchmark** | `npm run test:llm` | Revisa que el **cerebro del bot** entienda bien los mensajes de los clientes. |
| **Watchdog** | `npm run test:watch` | El **encargado que no duerme**: vigila tus archivos y corre las pruebas solo cuando cambia algo. |

Ninguna de las tres le escribe a nadie por WhatsApp. Al final del documento se explica
el único punto donde WhatsApp aparece (y por qué).

---

## 1. Diagrama del flujo completo

Así se ve el recorrido de principio a fin:

```

 [ Guardás un archivo en la carpeta ]
                  │
                  ▼
   ┌─────────────────────────────────────┐
   │  WATCHDOG  (solo si está corriendo)  │
   │  mira cada 2 segundos si algo cambió │
   └──────────────────┬──────────────────┘
                      │  ¿cambió algo?
                      │
          ┌───────────┴───────────┐
          │ No                    │ Sí
          ▼                       ▼
   vuelve a mirar        ¿el cambio toca código
   en 2 segundos         o configuración?
    (revive el server           │
     si se cayó)          ┌─────┴─────┐
                          │ No       │ Sí
                          ▼          ▼
                   solo pruebas  reinicia el server
                   (sin tocar    con el código nuevo
                    el server)        │
                          │            │
                          └─────┬──────┘
                                ▼
              ┌────────────────────────────────────────────┐
              │  QA RUNNER  (npm run test:smart)           │
              │  1. Ve qué archivos cambiaron              │
              │  2. Decide qué pruebas tocan (mapa)        │
              │  3. Se asegura de que el server esté vivo  │
              │  4. Corre las pruebas HTTP #1..#15          │
              └───────────────────┬────────────────────────┘
                                  │  ¿el cambio fue de IA/prompts
                                  │  o de configuración global?
                                  ▼
                        ┌──────────────────────────┐   No (tocaste
                        │  LLM BENCHMARK           │   otro archivo)
                        │  (npm run test:llm)      │ ───────────────┐
                        │  ¿Confirmás gastar        │               │
                        │   tokens? ──No→ se omite  │               │
                        │  Sí ─► 20 casos de prueba │               │
                        │  ─► score por categoría   │               │
                        │  ─► umbral 90%            │               │
                        └──────────┬───────────────┘               │
                                   ▼                               ▼
                     ┌────────────────────────────────────────────────────┐
                     │         REPORTE QA final                          │
                     │  · Resultado de las pruebas HTTP (X/15)           │
                     │  · Bloque [LLM] si corrió el benchmark (X/20)     │
                     │  · Exit 0 = todo bien | Exit 1 = algo falló       │
                     └────────────────────────────────────────────────────┘
```

En las próximas secciones se explica cada pieza por separado.

---

## 2. QA Runner — «reviso el kiosco» (`npm run test:smart`)

Es una **revisión médica del servidor web**. Hace pedidos HTTP reales a
`http://localhost:8000` (el server corriendo en tu máquina) y comprueba las respuestas.

### Cómo decide qué probar

1. Pregunta a **git** qué archivos cambiaron en tu carpeta (modificados, agregados y sin commitear).
2. Con el **mapa archivo → pruebas** decide el subconjunto (o la suite completa).
3. Se asegura de que el server esté arriba en el puerto `8000`: si no responde, lo arranca solo.
4. Corre las pruebas elegidas y emite el **reporte**.

### Qué comprueba cada prueba (#1..#15)

| # | Nombre | Qué hace en criollo |
|---|---|---|
| 1 | Health | Pregunta "¿estás vivo?" (`/health`) → debe responder `OK`. |
| 2 | Páginas públicas | Abre la página principal y las de pago, → deben cargar (200). |
| 3 | API config | Pide la configuración del negocio → debe traer datos (teléfono, precio). |
| 4 | Registro vacío | Intenta registrarse sin datos → debe rechazarlo (400). |
| 5 | Email inválido | Se registra con `noesemail` → debe rechazarlo (400). |
| 6 | Password débil | Se registra con clave corta/débil → debe rechazarlo (400). |
| 7 | Login vacío | Entra sin usuario/clave → debe rechazarlo (400). |
| 8 | Login inválido | Entra con datos inventados → debe rechazarlo (401). |
| 9 | Contacto | Manda el formulario de contacto + verifica el "honeypot" anti-spam. |
| 10 | Panel `/app/*` | Abre login/register/qr/config → deben cargar o redirigir al login. |
| 11 | Assets | Pide los archivos de iconos JS → deben venir como JavaScript. |
| 12 | SPA catch-all | Pide una ruta inexistente → la app debe mostrar su página (no un error). |
| 13 | Admin protegido | Pide logs/eventos de admin sin loguearse → debe negarlo (403). |
| 14 | Webhook MP | Simula un aviso de Mercado Pago → debe responder rápido (200). |
| 15 | Check-status | Pregunta estado de pago → debe devolver un estado, aunque sea "unknown". |

### El mapa archivo → pruebas

- **Archivos globales** (`package.json`, `.env`, `.env.example`, `config.json`,
  `nodemon.json`, `Dockerfile`, `docker-compose.yml`, `.gitignore`,
  `package-lock.json`) → **suite completa + benchmark LLM**. Si cambia la
  configuración de raíz, todo se revisa a fondo.
- **Archivos de IA/prompts** (`aiTranslatorController.js`, `intentRouterService.js`,
  `llmChatService.js`, `scripts/test-llm-router.js`, `tests/fixtures/llm_test_cases.json`)
  → corren el **benchmark LLM** además de su prueba HTTP correspondiente.
- **Rutas puntuales** (ejemplos):
  - `server.js` → suite completa (concentra todas las rutas).
  - `public/index.html`, `public/suscripcion.html`, `public/pago_exitoso.html` → páginas públicas.
  - `app/src/utils/dashboard.js` → panel (`#10`).
  - `app/src/services/userService.js` → registro + login + admin (`#4..#8, #13`).
  - `app/src/services/mercadoPagoService.js` → Mercado Pago (`#14, #15`).
  - `app/src/controllers/menuController.js`, `aiTranslatorController.js` → smoke (`#1, #10`).
- **Archivo nuevo sin mapeo exacto** → el runner **infiere** el test set por
  **palabras clave de su nombre/ruta** antes de aplicar la regla de carpeta.
  Por ejemplo: un archivo nuevo con `billing/pago/pay` → Mercado Pago (`#13,#14,#15`);
  `user/auth/login` → cuentas (`#4..#8, #13`); `email/contact` → contacto (`#9`);
  `turno/menu/catalog` → panel (`#1,#10`); `ai/llm/intent/prompt` → `#1,#10` **+ benchmark
  LLM**. Si ninguna palabra aplica, pasa al fallback de carpeta o a suite completa.
- **Por carpeta** (regla general si no hay coincidencia exacta ni inferencia): `public/` → assets,
  `app/src/services/` y `app/src/utils|models` → panel (`#10`),
  `app/src/controllers/` y `app/` → smoke (`#1, #10`), `scripts/` → smoke (`#1`).
- **Archivo desconocido** (nadie sabe qué toca) → **suite completa** como precaución.
- **Archivos `.md`** (documentación) → se ignoran, no afectan la app.

El reporte final muestra el bloque **`Cobertura del mapeo`**: qué archivos se mapearon por
inferencia (`inferido`), por regla de carpeta (`genérico`) y cuáles quedaron sin mapeo
(`sin mapeo`, que forzaron la suite completa). Así nunca hay cobertura silenciosa: si aparece
una línea `sin mapeo`, considerá agregar el archivo a `EXACT_MAP` o un test dedicado en
`tests/`.

> Nota: mientras los archivos nuevos del sistema de testing (`scripts/*`, `tests/*`)
> estén **sin commitear**, git los reporta como "cambiados" y el QA corre la suite
> completa. Una vez commiteados, dejan de aparecer.

---

## 3. LLM Benchmark — «pruebo el cerebro» (`npm run test:llm`)

Esta pieza **no toca el servidor ni WhatsApp**. Toma el **mismo código de decisión
del bot** (el `IntentRouterService`), le inyecta un **catálogo falso en memoria**
(como si el comercio tuviera 3 o 4 productos), y le hace **20 preguntas de prueba**.

### De dónde salen las preguntas

De `tests/fixtures/llm_test_cases.json`. Hay **3 perfiles** (escenarios reales del bot):

| Perfil | Negocio de fantasía | Cuántas preguntas | Qué valida |
|---|---|---|---|
| `CARRITO` | Pizzería Don Pepito | 7 | Agregar al pedido, consultas de precio, productos inexistentes, horarios. |
| `TURNOS` | Peluquería Bella | 6 | Reservar/cambiar/ver turnos (debe navegar al flujo, NO vender un turno), horarios, charla. |
| `FAQ` | Inmobiliaria Centrox (sin carrito) | 7 | Preguntas sobre fichas, secciones, horarios, chau/gracia. |

Cada pregunta tiene su **expectativa**: qué intención debe devolver, qué producto con
qué cantidad, y qué intenciones **no** debe usar (por ejemplo: en un bot de turnos,
una reserva jamás puede clasificarse como "agregar al carrito").

### El flujo de una prueba

1. Se arma el router con el perfil (catálogo simulado + si tiene carrito o no).
2. Se le manda el mensaje: "Quiero reservar para cortarme el pelo mañana a las 10am".
3. El router pregunta al servicio de IA (`gpt-4o-mini` de OpenAI) qué intenciones tiene.
4. La respuesta se compara contra la expectativa.
5. Al terminar, se muestra el score **por categoría** y el **global**.

### La barrera de los tokens (muy importante)

El servicio de IA **cuesta dinero** (unos centavos por corrida). Por eso el benchmark
tiene una **compuerta de confirmación**:

| Situación | Qué pasa |
|---|---|
| Lo corrés desde una terminal | Te pregunta **"¿Ejecutar? [y/N]"** y espera hasta **60 segundos**. Si no respondés, se omite (no gasta). |
| Sin terminal interactivo (automático) | **Se omite sin gastar** — nunca consume sin tu OK. |
| `--yes` o `QA_LLM_AUTO=1` | Ejecuta sin preguntar (para CI o cuando vos ya lo autorizaste). |
| `--dry-run` | **No llama a la IA**: solo valida que los fixtures estén bien. Cuesta cero. |

Ejemplos:

```
npm run test:llm              # pregunta antes de gastar
npm run test:llm -- --yes     # ejecuta directo
npm run test:llm -- --dry-run # chequeo sin costo
```

### El umbral (gate) del 90%

- Se calcula el acierto por categoría y el global.
- Si el **global** o **alguna categoría** baja del **90%**, el benchmark **falla**
  (código de salida `1`). Es una alarma: algo del comportamiento inteligente se rompió.
- Resultado de referencia de la última corrida: **20/20 (100%)**.

---

## 4. Watchdog — «el encargado» (`npm run test:watch`)

Es un programa que queda **corriendo en segundo plano** y mira tu carpeta
**cada 2 segundos**. Es el que hace que el testing sea automático:

- **Ves que un código cambió** → apaga y vuelve a encender el server con esa novedad
  (toma el control del puerto `8000`) y corre el QA Runner.
- **Cambió algo que no afecta al server** → corre el QA sin reiniciar.
- **El server se cayó** → lo revive solo.
- Cuando termina, te avisa `tests OK` o `tests con fallos`.

### Para que se active solo al abrir VS Code (una vez por carpeta)

El archivo `.vscode/tasks.json` tiene programada la tarea **"QA Smart Watchdog"** para
arrancar automáticamente al abrir la carpeta. La primera vez, VS Code te preguntará:

1. `Ctrl+Shift+P` → **Tasks: Manage Automatic Tasks in Folder** → **Allow Automatic Tasks**.
2. `Ctrl+Shift+P` → **Developer: Reload Window**.

A partir de ahí, al abrir la carpeta verás en el terminal integrado los mensajes
`[QA Watchdog] Starting...` y luego `[QA Watchdog] Ready ...`, el servidor en `:8000`
y los avisos de pruebas cuando guardes archivos.

---

## 5. WhatsApp — la aclaración honesta

**Las pruebas no usan WhatsApp.** El QA habla con el servidor por HTTP local; el
benchmark habla con OpenAI; ninguno manda mensajes ni simula conversaciones.

**Pero hay un efecto secundario:** cuando el servidor arranca (cosa que pasa al correr
el QA o el watchdog), la aplicación revisa si hay **botes con sesión de WhatsApp
guardada y activa** y los conecta automáticamente. En tu carpeta existe
`auth_sessions/auth_info_test_inmobiliaria/creds.json`, así que **`test_inmobiliaria`
se conecta a WhatsApp real** cada vez que el server arranca.

No manda mensajes de prueba: solo se conecta y queda a la espera. Si en algún momento
quisieras arrancar el server sin conectar ningún bot, es un cambio chico de
configuración que se puede hacer.

---

## 6. Cómo leer el reporte final

Después de una corrida del QA vas a ver, en el panel de terminal:

```
════════════════════════════════════════════════
REPORTE QA SMART — bot_menu (localhost:8000)
════════════════════════════════════════════════
Archivos modificados:
  • app/src/controllers/menuController.js
  • package.json
Modo: SUITE COMPLETA (#1..#15)
Módulos testeados:
  ✔ [1] Health /health
  ✖ [8] API POST /api/login (credenciales inválidas)   ← ojo con esta
  ✔ [15] API /api/mercadopago/check-status
  ✔ [LLM] Benchmark de IA (test:llm)
----------------------------------------------------
Resultado HTTP: 14/15 PASS
════════════════════════════════════════════════
```

- Cada línea `✔`/`✖` es una prueba con su resultado.
- Si corrió, aparece el bloque `[LLM]` (el benchmark de IA).
- `Resultado HTTP: X/15 PASS` es el resumen de las pruebas del servidor.
- El comando termina con un **código de salida**: `0` = todo bien, `1` = algo falló.

### Códigos de salida del benchmark (`test:llm`)

| Código | Significado |
|---|---|
| `0` | OK (score ≥ 90%) o benchmark omitido por confirmación. |
| `1` | Precisión < 90% (global o alguna categoría). |
| `2` | Error de configuración (falta API key, fixtures inválidos). |

---

## 7. Comandos de un vistazo

| Comando | Qué hace | ¿Gasta tokens? |
|---|---|---|
| `npm run test:smart` | QA HTTP de una pasada (server + rutas). | No |
| `npm run test:llm` | Benchmark del cerebro (20 casos). Pide confirmación. | Sí, si confirmás |
| `npm run test:llm -- --yes` | Benchmark sin preguntar. | Sí |
| `npm run test:llm -- --dry-run` | Valida fixtures, sin llamar a la IA. | No |
| `npm run test:watch` | Vigilante automático (server + QA + benchmark). | Solo si corre el benchmark |
| `npm start` / `npm run dev` | El servidor normal, sin supervición de QA. | No |

---

## 8. Glosario corto (sin humo)

- **HTTP / endpoint**: la forma en que los programas se piden cosas por internet local.
  Un "endpoint" es una dirección: `GET /api/config` = "traeme la configuración".
- **Server / Express**: el programita que atiende esas direcciones desde tu máquina.
- **git**: el historial de tus archivos. El QA le pregunta "¿qué cambiaste?".
- **Fixture**: un archivo de datos de prueba prearmado (acá, las 20 preguntas).
- **IntentRouterService**: el "cerebro" del bot que decide qué intención tiene un mensaje
  (comprar, preguntar, pedir turno, chusmear).
- **gpt-4o-mini**: el modelo de IA que el cerebro usa para decidir. Es el que cobra tokens.
- **Function calling**: la técnica por la cual la IA devuelve una "ficha" estructurada
  (intención + producto + cantidad) en vez de texto libre.
- **Token**: la unidad mínima de texto que cobra la IA (1000 tokens ≈ una página).
- **TTY / terminal interactivo**: una terminal de verdad donde se puede escribir.
  Sin eso, el benchmark decide no gastar.
- **Exit code (código de salida)**: el número con el que un comando termina
  (`0` = bien, `1`/`2` = mal). Es lo que los sistemas usan para saber si una prueba pasó.