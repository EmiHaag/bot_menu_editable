# Configuración de Volúmenes Persistentes en Koyeb

## Volumen Persistente
Las sesiones de WhatsApp se guardan en `/data/auth_sessions`, que debe ser un volumen persistente en Koyeb.

### Verificación en Koyeb:

Verifica que el volumen persistente esté configurado con:
- **Ruta de montaje en el contenedor**: `/data`
- El volumen ya debe estar creado y funcionando

### Variables de Entorno (opcional)
Si necesitas usar una ruta diferente, puedes establecer:
```
AUTH_SESSIONS_DIR=/data/auth_sessions
```

Por defecto, la app usa `/data/auth_sessions`.

## Verificación
Después de configurar el volumen:
1. Reinicia el servicio en Koyeb
2. Escanea un código QR para autenticar
3. Reinicia el contenedor nuevamente
4. Verifica que la sesión se mantuvo (no debe pedir escanear QR nuevamente)

## Manejo de la carpeta
La aplicación (app.js) se asegura de que la carpeta `/app/auth_sessions` exista cuando inicia. Koyeb maneja la persistencia del volumen montado.

## Docker Compose (Local)
Para desarrollo local:
```yaml
volumes:
  - ./auth_sessions:/app/auth_sessions
```

Esto mapea la carpeta local `./auth_sessions` al contenedor.
