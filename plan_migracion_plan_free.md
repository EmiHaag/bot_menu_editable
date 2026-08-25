# Plan de Migración: Prueba Gratuita sin Tarjeta de Crédito

## Resumen del cambio
Migrar del modelo actual (suscripción MP con trial de 30 días en Mercado Pago) a un modelo de "Prueba Gratuita sin Tarjeta" donde el usuario se registra gratis, tiene 30 días de acceso completo, y al vencer se pausa el bot hasta que pague.

## Arquitectura actual vs propuesta

### Actual
```
Landing → Formulario (name/email/dni) → MP checkout (con trialPeriodDays=30) 
→ Webhook/Redirect → Crear usuario + suscripción → Bot activo
```

### Propuesta
```
Landing → Formulario de registro (name/email/password) → Usuario creado con trial=30d 
→ Acceso inmediato al dashboard + bot
→ [Día 25/28/30] Emails de recordatorio
→ [Día 30] Bot detenido, dashboard muestra "Activar plan"
→ Usuario hace clic "Activar plan" → MP checkout (sin trial de MP, con external_reference)
→ Webhook → Busca usuario por external_reference (idCliente) → Actualiza a ACTIVE
→ Bot reactivado
```

## Cambios por archivo

### 1. `app/src/services/billingService.js`
- **ensureTable()**: Agregar `trial_start_date TIMESTAMPTZ` y `trial_end_date TIMESTAMPTZ` a la tabla users
- **estadoSuscripcion()**: Extender con estados `trial` y `trial_vencido`
  - Si `trial_end_date` existe Y `fecha_pago` no existe:
    - `UTC_NOW < trial_end_date` → `"trial"`
    - `UTC_NOW >= trial_end_date` → `"trial_vencido"`
  - Si `fecha_pago` existe → lógica actual (activa/gracia/suspendida)
- **Nueva función `diasRestantesTrial(trialEndDate)`**: Calcula días restantes del trial

### 2. `app/src/services/userService.js`
- **mapRow()**: Agregar `trialStartDate: row.trial_start_date` y `trialEndDate: row.trial_end_date`
- **ensureTable()**: ALTER TABLE para agregar columnas trial
- **addUser()**: Aceptar y persistir `trialStartDate`, `trialEndDate`
- **Nuevo método `getUserByExternalId(idCliente)`**: Alias de `getUserByIdCliente()` para claridad en el flujo de pago
- **Nuevo método `activarDesdeTrial(idCliente)`**: Pasa estado de trial a activo (fecha_pago, fecha_vencimiento, activo=true)

### 3. `app/src/services/mercadoPagoService.js`
- **createPreapproval()**: Agregar parámetro `externalReference` al body de MP
  ```javascript
  if (externalReference) {
      body.external_reference = externalReference;
  }
  ```

### 4. `app/src/services/emailService.js`
- **sendTrialReminderEmail({ to, name, diasRestantes })**: Email de recordatorio del trial
  - Template similar al de suspensión pero con tono de "tu prueba termina en X días"
  - Incluir botón "Activar mi plan" que linka a /suscripcion

### 5. `server.js`
- **Nuevo endpoint `POST /api/register`**:
  - Recibe: `{ name, email, password, dni }`
  - Valida email único (ya existe en BD → error)
  - Genera `idCliente` con `generateClientId()`
  - Genera `username` con `generateUsername(email)`
  - Crea usuario con `trial_start_date=NOW()`, `trial_end_date=NOW()+30d`, `activo=true`
  - Registra en `suscripciones` tabla con estado `trial`
  - Envía email de bienvenida
  - Retorna `{ success, username, password, email }` (o redirect a dashboard)
- **Modificar `POST /api/mercadopago/create-subscription`**:
  - Si el usuario está logueado (tiene sesión), usar su `idCliente` como `external_reference`
  - Si el usuario viene del formulario de /suscripcion (no logueado), buscar usuario por email y usar su `idCliente`
  - Si no existe usuario con ese email → es un usuario nuevo sin trial, crear uno normal
  - `trialPeriodDays` siempre = 0 (no más trial de MP)
- **Modificar `verificarVencimientos()`**:
  - Agregar lógica para usuarios con trial vencido:
    - `estado === 'trial_vencido'` → stopBotConnection, enviar email de trial vencido
  - Agregar recordatorios de trial (días 25, 28, 30)
- **Nueva función `enviarAvisoTrial(user, diasRestantes)`**: Envía email de recordatorio

### 6. `app/src/app.js`
- **Nueva ruta `GET /register`**: Página de formulario de registro
- **Nueva ruta `POST /register`**: Procesa registro (llama a `POST /api/register` logic)
- **Modificar login page**: Agregar botón/link "Registrate gratis 30 días"
- **Modificar `POST /api/bot/start/:id`**: Agregar `trial_vencido` a la condición de bloqueo
- **Modificar `GET /api/mi-suscripcion`**: Agregar campos de trial al response
- **Modificar dashboard QR**: Mostrar banner de trial (días restantes, link a upgrade)

### 7. Frontend Dashboard (inline HTML en app/src/app.js)
- En la página QR, si el usuario tiene trial activo, mostrar banner informativo
- Si trial vencido, mostrar "Tu prueba terminó. Activá tu plan para continuar"
- En /suscripcion, pre-llenar email si el usuario viene del trial

## Secuencia de implementación (orden dependiente)

1. billingService.js (schema + lógica de estados)
2. userService.js (schema + campos trial)
3. mercadoPagoService.js (external_reference)
4. emailService.js (templates de trial)
5. server.js (register + modificar subscription + vencimientos)
6. app/src/app.js (register UI + dashboard + bot blocks)
7. Frontend tweaks
8. Verificación

## Datos de migración existentes
- Los usuarios actuales que vienen de MP tienen `fecha_pago` y `fecha_vencimiento` pero NO `trial_start_date` ni `trial_end_date`
- La lógica de `estadoSuscripcion()` debe priorizar: si `trial_end_date` es null → usar lógica actual
- No se requiere migración de datos existentes

## Anti-abuso
- Email único: ya existe índice parcial `users_email_uq` en `userService.js:65`
- Un solo trial por cuenta: al registrar, verificar que no exista usuario con el mismo email
- Rate limiting en registro: reutilizar la lógica de `loginAttempts` del login

##external_reference (Opción A+B)
- Al crear preaprobación de MP, enviar `external_reference: idCliente`
- En `asgurarSuscripcion()`, cuando llega el webhook:
  1. Si tiene `external_reference` → buscar usuario por `id_cliente`
  2. Si lo encuentra → actualizar su cuenta (no crear nueva)
  3. Si no tiene `external_reference` → buscar por email (fallback)

## Verificación final
- Probar registro completo (POST /api/register) ✅
- Probar que el bot arranca después del registro ✅
- Probar que al vencer trial, el bot se detiene ✅
- Probar que el login funciona para usuarios en trial ✅
- Probar que la página de suscripción muestra el plan ✅
- Verificar que no se rompe el flujo de pago existente para usuarios nuevos sin trial ✅

## Estado de implementación: COMPLETADO
Todos los archivos modificados:
- `billingService.js`: Estados trial + trial_vencido + diasRestantesTrial
- `userService.js`: Campos trial en schema + activarDesdeTrial + guardarAvisoTrial
- `mercadoPagoService.js`: external_reference en createPreapproval
- `emailService.js`: sendTrialReminderEmail + sendTrialExpiredEmail
- `server.js`: POST /api/register, create-subscription sin trial MP, verificarVencimientos con trial, asgurarSuscripcion con external_reference
- `app/src/app.js`: Ruta /register, login link, bot block trial_vencido, mi-suscripcion con datos trial, dashboard banner
