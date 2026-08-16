# Configuración de Volúmenes Persistentes en Koyeb

## Volumen Persistente
Las sesiones de WhatsApp se guardan en `/data/auth_sessions`, que debe ser un volumen persistente en Koyeb.

### Verificación en Koyeb:

Verifica que el volumen persistente esté configurado con:
- **Ruta de montaje en el contenedor**: `/data`
- El volumen ya debe estar creado y funcionando

### Variables de Entorno
Por defecto, la app usa la carpeta local `auth_sessions` dentro del proyecto. 

Para entornos de producción como **Koyeb**, es **obligatorio** configurar las siguientes variables de entorno:

### Variables de volumen y sesión
```
AUTH_SESSIONS_DIR=/data/auth_sessions
SESSION_SECRET=<clave-secreta-aleatoria>
```

### Neon PostgreSQL (Términos y Condiciones)
```
NEON_DATABASE_URL=postgresql://neondb_owner:<password>@<endpoint>.neon.tech/<dbname>?sslmode=require
```
Las tablas `terms_approvals`, `bots` y `turnos` se crean automáticamente al iniciar el servidor.

### Autenticación Google (OAuth2)
```
OAUTH_CREDENTIALS_CONTENT=<JSON credenciales cliente OAuth>
OAUTH_TOKEN_CONTENT=<JSON token de acceso + refresh_token>
```
**Importante**: para el Gestor de Turnos, el token debe incluir el scope `https://www.googleapis.com/auth/calendar` además de `spreadsheets` y `drive`. Para re-generarlo con los scopes actualizados ejecutá localmente `node auth_calendar.js`, aprobá el consentimiento (servidor local en `http://localhost:3000`) y pegá el nuevo JSON en `OAUTH_TOKEN_CONTENT`.

### Email (SMTP) - Recuperación de contraseña y bienvenida
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu-email@gmail.com
SMTP_PASS=tu-app-password
```

### MercadoPago y URL del sitio
```
MERCADOPAGO_ACCESS_TOKEN=APP_USR-...
SITE_URL=https://tu-dominio.koyeb.app
```

## Verificación
Después de configurar el volumen:
1. Reinicia el servicio en Koyeb
2. Escanea un código QR para autenticar
3. Reinicia el contenedor nuevamente
4. Verifica que la sesión se mantuvo (no debe pedir escanear QR nuevamente)

## Planilla Google Sheets
Los encabezados de la pestaña `Usuarios` se crean/actualizan automáticamente al iniciar el servidor. Columnas actuales:

| A | B | C | D | E | F | G | H | I |
|---|---|---|---|---|---|---|---|---|
| id_cliente | nombre_cliente | activo | user | password | fecha_suscripcion | spreadsheetId | email | fecha_terminos |

No es necesario crear los encabezados manualmente.

## Manejo de la carpeta
La aplicación (`app.js`) se asegura de que la carpeta configurada en `AUTH_SESSIONS_DIR` exista cuando inicia. 

## Docker Compose (Local)
Para desarrollo local:
```yaml
volumes:
  - ./auth_sessions:/app/auth_sessions
```

Esto mapea la carpeta local `./auth_sessions` al contenedor.
