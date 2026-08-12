# Facturación Electrónica ARCA

Documentación viva de la integración con los Web Services de ARCA (ex AFIP) para facturación electrónica. Se actualiza a medida que avanza el desarrollo.

## Estado actual

| Ítem | Estado |
|---|---|
| Conexión a ARCA (producción) | ✅ Funcionando |
| Login WSAA con cert/key | ✅ Funcionando |
| Consulta último comprobante (Factura C) | ✅ Funcionando |
| Emisión de comprobantes (CAE) | ✅ Funcionando (`arcaService.js`) |
| Integración con `server.js` (facturación automática) | ✅ Funcionando (webhook MercadoPago) |
| PDF de comprobante | 🔜 Pendiente |

## Librería

Se usa **`afip-apis`** (v0.5.5), que conecta directo por **WSAA** (SOAP) con certificado y clave privada — sin intermediarios ni tokens de terceros.

> ⚠️ **No usar `@afipsdk/afip.js`**: la versión instalada (1.2.x) enruta todos los pedidos por `app.afipsdk.com` y exige un `access_token` de esa plataforma (401 sin él). Por eso se descartó.

## Variables de entorno (.env)

```
#ARCA FACTURA AUTOMATICA
AFIP_CUIT=20271391979        # CUIT titular
AFIP_PTO_VTA=1               # Punto de venta habilitado para WS
AFIP_CERT_PATH=./app/src/certs/saas-bot_42d9aa44d933064d.crt
AFIP_KEY_PATH=./app/src/certs/privada.key
AFIP_PRODUCTION=true         # true = producción | false = homologación
```

## Certificados

- Los certificados son **por ambiente**: uno de producción **no funciona** en homologación y viceversa. Error típico por mezclarlos: `cms.cert.untrusted` ("Certificado no emitido por AC de confianza").
  - **Producción**: se obtienen en el portal ARCA → "Administración de Certificados Digitales". Los emite la AC `CN=Computadores, O=AFIP, C=AR`.
  - **Homologación**: se obtienen en **WSASS** (`wsass-homo.afip.gob.ar`) con clave fiscal.
- El cert actual es de **producción** (emitido 11/08/2026, vence 10/08/2028).
- Requisito: el certificado debe estar asociado al servicio `wsfe` (Administrador de Relaciones). Si no, falla con `coe.notAuthorized`.

## Prueba de conexión

Script `test-arca.js` en la raíz del proyecto. Ejecutar:

```
node test-arca.js
```

Flujo del script:
1. `FEDummy` → estado de los servidores de ARCA (`AppServer`, `DbServer`, `AuthServer`).
2. `LoginTicket.wsaaLogin('wsfe', wsaaUrl, certPath, keyPath)` → obtiene `token` + `sign` (válidos ~12 h).
3. `FECompUltimoAutorizado({ Auth, PtoVta, CbteTipo: 11 })` → último número de Factura C.

Salida esperada:

```
✅ Estado del servidor ARCA: { AppServer: 'OK', DbServer: 'OK', AuthServer: 'OK' }
✅ Login WSAA OK. Vence: <fecha>
✅ Última Factura C emitida en Punto de Venta 1: N° <nro>
```

Si dice `N° 0`, significa que todavía no se emitió ninguna factura en ese punto de venta.

## ⚠️ Workaround TLS (obligatorio en producción)

Los servidores de ARCA usan claves **DH pequeñas**, que Node ≥ 17 (OpenSSL 3) rechaza por seguridad con:

```
Error: write EPROTO ... dh key too small
```

Solución: bajar el nivel de seguridad de OpenSSL **solo para estas conexiones** inyectando `ciphers: 'DEFAULT:@SECLEVEL=0'`. Como `afip-apis` usa la librería `request` internamente, se parchea `request.post` antes de requerir `afip-apis`:

```js
const request = require('request');

const origPost = request.post.bind(request);
request.post = function (options, callback) {
  if (options && typeof options === 'object' && !options.ciphers) {
    options.ciphers = 'DEFAULT:@SECLEVEL=0';
  }
  return origPost(options, callback);
};
```

> El `--openssl-config` de Node NO funcionó para este caso; el `https.Agent` con ciphers bajos sí (mismo patrón que `arcasdk` con `useHttpsAgent`). Este workaround también hará falta al integrar la facturación en `server.js`.

## Errores conocidos

| Error | Causa | Solución |
|---|---|---|
| `401 Unauthorized` (`Necesitás un access_token`) | Usar `@afipsdk/afip.js` sin token | Usar `afip-apis` (WSAA directo) |
| `cms.cert.untrusted` | Cert de un ambiente usado en el otro | Usar cert correcto para el ambiente |
| `coe.notAuthorized` | Cert no asociado al servicio | Asociar `wsfe` en Administrador de Relaciones |
| `dh key too small` | Node/OpenSSL 3 vs servidores ARCA | Parche de `ciphers` (ver arriba) |
| `cms.cert.expired` / `cms.cert.revoked` | Cert vencido o revocado | Generar cert nuevo |

## Próximos pasos

- [ ] Mantener caché del ticket WSAA (válido ~12 h) — ✅ implementado en `arcaService.js` (caché en memoria con expiración).
- [x] Emitir comprobante con CAE (`FECAESolicitar`): Concepto 2 (servicios), DocTipo/DocNro, ImpTotal, IVA no discriminado.
- [x] Integrar facturación automática en el webhook de MercadoPago (pago `approved` → Factura C + mail).
- [x] Idempotencia por `payment_id` (tabla `facturas`, `UNIQUE(payment_id)`).
- [ ] Generación de PDF del comprobante (vía `@arcasdk/pdf` o similar).

## Cómo funciona la facturación automática

1. El webhook `POST /api/mercadopago/webhook` recibe `subscription_authorized_payment` (cobro recurrente) o `payment` (`payment.created`).
2. Si el pago está `approved`, se resuelve la suscripción (tabla `suscripciones`, key = `preapproval_id`).
3. Se emite la Factura C (CbteTipo 11) vía `arcaService.emitirFacturaC()` → CAE + N° comprobante.
4. Se registra en la tabla `facturas` (idempotente por `payment_id`; si ARCA ya procesó ese pago, no se vuelve a facturar).
5. Se renueva `fecha_pago`/`fecha_vencimiento` (+1 mes) en `suscripciones` y `users`.
6. Se envía el mail con el comprobante en HTML (`emailService.sendInvoiceEmail`).

> Nota: el comprobante se emite con **Concepto 2** (servicios), **IVA no discriminado** (neto = total) y los datos fiscales del cliente (DNI/CUIT) que se piden en el formulario de suscripción.
