# Flujo UX — Sistema de Prueba Gratuita

## Resumen

El usuario se registra gratis, obtiene 30 días de acceso completo sin tarjeta de crédito, y al vencer se pausa el bot hasta que active su plan de pago.

---

## Estados de cuenta

| Estado | Significado | Bot | Dashboard |
|--------|-------------|-----|-----------|
| `trial` | Registrado, dentro de los 30 días | Funciona | Acceso completo |
| `trial_vencido` | 30 días agotados, sin pago | Detenido | Acceso (con banner de upgrade) |
| `activa` | Pago al día | Funciona | Acceso completo |
| `gracia` | Pago vencido, dentro de los 10 días de gracia | Detenido | Acceso (con aviso) |
| `suspendida` | Pago vencido + 10 días de gracia agotados | Detenido | Bloqueado |
| `sin_suscripcion` | Sin registro ni pago | — | — |

---

## Flujo paso a paso

### 1. Registro (día 0)

```
Landing → "Registrate gratis 30 días" → /app/register
  → Formulario: nombre, email, contraseña
  → POST /api/register
    → Crea usuario en BD: trial_start_date=ahora, trial_end_date=+30d
    → Email de bienvenida con credenciales
    → Auto-login → redirect a /app/qr
```

El usuario ya puede:
- Ingresar al dashboard
- Escanear el QR de WhatsApp
- Configurar su menú
- Usar el bot normalmente

### 2. Uso del trial (días 1-25)

Sin cambios. El bot funciona con total normalidad. El usuario puede:
- Escanear el QR y conectar WhatsApp
- Editar menús desde el dashboard
- Recibir y procesar pedidos

### 3. Recordatorios de vencimiento

El job `verificarVencimientos()` corre cada 6 horas y envía emails automáticos:

| Días restantes | Email | Contenido |
|---------------|-------|-----------|
| 5 | Recordatorio | "Tu prueba termina en 5 días. Activá tu plan." |
| 2 | Recordatorio | "Quedan 2 días." |
| 1 | Recordatorio | "Quedan 1 día." |
| 0 | Aviso de vencimiento | "Tu prueba terminó. Tu bot se pausó." |

El dashboard también muestra un banner informativo con los días restantes y un link a `/suscripcion`.

### 4. Vencimiento del trial (día 30)

```
verificarVencimientos() detecta: trial_end_date < ahora Y fecha_pago = null
  → Estado pasa a "trial_vencido"
  → stopBotConnection() detiene el bot
  → Email: "Tu prueba terminó"
```

El usuario puede:
- Seguir ingresando al dashboard (no se bloquea el login)
- Ver su configuración
- Ver el banner "Tu prueba terminó. Activá tu plan"
- **NO puede** reconectar el bot (el botstart lo bloquea)

### 5. Activación del plan (conversión)

```
Usuario hace clic "Activar mi plan" → /suscripcion
  → Formulario: nombre, email, DNI/CUIT
  → POST /api/mercadopago/create-subscription
    → Backend resuelve external_reference = idCliente del usuario
    → Crea preaprobación en MP (sin trialPeriodDays, con external_reference)
    → Redirect a checkout de MP
  → Usuario paga con tarjeta/débito en MP
```

### 6. Confirmación del pago (webhook)

```
MP envía webhook → POST /api/mercadopago/webhook
  → manejarPreapproval() extrae external_reference del preapproval
  → asegurarSuscripcion() busca usuario por external_reference (id_cliente)
    → Encuentra al usuario trial existente (NO crea cuenta nueva)
    → Registra la suscripción en tabla suscripciones
    → activarDesdeTrial(): fecha_pago=ahora, fecha_vencimiento=+1mes, activo=true
  → reconciliarCobros() factura el primer cobro
  → Email de bienvenida con factura
  → Bot se reactiva automáticamente en el próximo inicio
```

### 7. Renovaciones mensuales

A partir del primer pago, el ciclo de renovación es automático:
- MP debita automáticamente cada mes
- Webhook confirma el cobro → se factura → se renueva `fecha_vencimiento`
- Si falla el débito, entra en período de gracia (10 días) y se reintenta

---

## Vínculo entre trial y pago (external_reference)

El problema que resuelve: el usuario puede tener un email diferente en MP que en nuestro sistema.

```
Registro: usuario crea cuenta con "juan@gmail.com"
  → idCliente = "cli_abc123"

Pago: usuario paga desde su cuenta MP "otro@gmail.com"
  → external_reference = "cli_abc123" (se envía al crear preaprobación)

Webhook: llega con external_reference = "cli_abc123"
  → Busca usuario con id_cliente = "cli_abc123"
  → Lo encuentra (es Juan)
  → Actualiza su cuenta existente (no crea nueva)
```

Si `external_reference` no está disponible (fallback), busca por email.

---

## Anti-abuso

- **Email único**: índice parcial `users_email_uq` previene registros duplicados con el mismo email
- **Un solo trial por email**: al registrar, se verifica que no exista usuario con ese email
- **Rate limiting**: máximo 5 intentos de registro por minuto por IP (reutiliza la lógica del login)

---

## Configuración

El flag `trial_gratis` en `config.json` controla si el trial está habilitado:

```json
{
  "trial_gratis": true
}
```

Si se pone en `false`, el sistema funciona como antes (suscripción MP directa sin trial propio).

---

## Migración de usuarios existentes

Los usuarios actuales que vinieron del flujo MP anterior tienen:
- `fecha_pago` y `fecha_vencimiento` (de MP)
- `trial_start_date` y `trial_end_date` = NULL

La lógica de `estadoSuscripcion()` prioriza: si `trial_end_date` es null, usa la lógica original basada en `fecha_vencimiento`. No se requiere migración de datos.

---

## Archivos involucrados

| Archivo | Rol |
|---------|-----|
| `server.js` | Endpoint `/api/register`, verificar vencimientos, webhooks MP |
| `app/src/app.js` | Rutas `/register`, login, dashboard QR, bot start |
| `billingService.js` | Estados de suscripción, cálculo de días |
| `userService.js` | CRUD de usuarios, campos trial |
| `mercadoPagoService.js` | API de MP con `external_reference` |
| `emailService.js` | Templates de recordatorio y vencimiento de trial |
