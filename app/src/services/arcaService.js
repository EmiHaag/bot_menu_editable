require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let wsfev1 = null;
let LoginTicket = null;
let libsLoaded = false;

// Ticket WSAA cacheado (~12h de validez). Se renueva recién 60s antes de expirar.
let cachedAuth = null;
let cachedAuthExpiresAt = 0;

// En Koyeb no hay archivos: el cert/key llegan por env var (AFIP_CERT_CONTENT /
// AFIP_KEY_CONTENT). Se escriben a /tmp al iniciar y se usan como paths.
let certsMaterialized = false;

function materializeCerts() {
  if (certsMaterialized) return;
  const write = (name, value) => {
    if (!value) return;
    let content = String(value).trim();
    if (!content.includes('-----BEGIN')) {
      try { content = Buffer.from(content, 'base64').toString('utf8'); } catch (e) { /* keep raw */ }
    }
    if (!content.endsWith('\n')) content += '\n';
    fs.writeFileSync(path.join('/tmp', name), content, { mode: 0o600 });
  };
  write('afip_cert.pem', process.env.AFIP_CERT_CONTENT);
  write('afip_key.pem', process.env.AFIP_KEY_CONTENT);
  certsMaterialized = true;
}

function certPaths() {
  if (process.env.AFIP_CERT_CONTENT || process.env.AFIP_KEY_CONTENT) {
    materializeCerts();
    return {
      certPath: process.env.AFIP_CERT_CONTENT ? '/tmp/afip_cert.pem' : process.env.AFIP_CERT_PATH,
      keyPath: process.env.AFIP_KEY_CONTENT ? '/tmp/afip_key.pem' : process.env.AFIP_KEY_PATH,
    };
  }
  return { certPath: process.env.AFIP_CERT_PATH, keyPath: process.env.AFIP_KEY_PATH };
}

// Diagnóstico local de los certificados (NO llama a AFIP). Sirve para verificar
// que Koyeb esté inyectando bien AFIP_CERT_CONTENT / AFIP_KEY_CONTENT.
function diagnoseCerts() {
  const report = { ok: null, checks: [] };
  const add = (name, ok, detail) => report.checks.push({ name, ok, detail });

  const certContent = process.env.AFIP_CERT_CONTENT;
  const keyContent = process.env.AFIP_KEY_CONTENT;
  const certPathEnv = process.env.AFIP_CERT_PATH;
  const keyPathEnv = process.env.AFIP_KEY_PATH;

  add('env', true, JSON.stringify({
    modo: certContent || keyContent ? 'CONTENT' : 'PATH',
    aFIPCUIT: process.env.AFIP_CUIT,
    aFIP_PRODUCTION: process.env.AFIP_PRODUCTION,
    AFIP_CERT_CONTENT: certContent ? `set (${certContent.length} chars)` : 'unset',
    AFIP_KEY_CONTENT: keyContent ? `set (${keyContent.length} chars)` : 'unset',
    AFIP_CERT_PATH: certPathEnv || 'unset',
    AFIP_KEY_PATH: keyPathEnv || 'unset',
  }));

  const hasLiteralBackslashN = (v) => Boolean(v && v.includes('\\n'));
  add('env-backslash-n', !hasLiteralBackslashN(certContent) && !hasLiteralBackslashN(keyContent),
    `cert literalBackslashN=${hasLiteralBackslashN(certContent)} key literalBackslashN=${hasLiteralBackslashN(keyContent)} (true = contenido pegado en 1 línea con \\n, hay que corregir)`);

  const paths = certPaths();
  try {
    const certPem = fs.readFileSync(paths.certPath, 'utf8');
    const keyPem = fs.readFileSync(paths.keyPath, 'utf8');
    report.certFile = paths.certPath;
    report.keyFile = paths.keyPath;
    add('files', true, `cert=${paths.certPath} (${certPem.length} bytes) key=${paths.keyPath} (${keyPem.length} bytes)`);

    const certLines = certPem.trim().split('\n').length;
    const keyLines = keyPem.trim().split('\n').length;
    add('pem-format', certPem.includes('-----BEGIN CERTIFICATE-----') && keyPem.includes('-----BEGIN'),
      `cert lineas=${certLines} inicia=${certPem.slice(0, 27).replace(/\n/g, '\\n')}... | key lineas=${keyLines} inicia=${keyPem.slice(0, 27).replace(/\n/g, '\\n')}...`);

    try {
      const cert = new crypto.X509Certificate(certPem);
      const now = new Date();
      const validTo = new Date(cert.validTo);
      const validFrom = new Date(cert.validFrom);
      const vigente = validFrom <= now && now <= validTo;
      add('cert', vigente,
        `subject=${cert.subject} | issuer=${cert.issuer} | desde=${cert.validFrom} hasta=${cert.validTo} | vigente=${vigente}`);

      try {
        const keyObj = crypto.createPrivateKey(keyPem);
        add('key', true, `tipo=${keyObj.asymmetricKeyType} | NO tiene passphrase`);
        const pubFromKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
        const pubFromCert = cert.publicKey.export({ type: 'spki', format: 'pem' });
        const match = pubFromKey === pubFromCert;
        add('key-cert-match', match, match ? 'key y cert coinciden (misma clave)' : 'Atención: la key NO se corresponde con el cert');
      } catch (e) {
        add('key', false, `error parseando key: ${e.message} (¿está cifrada con passphrase?)`);
      }
    } catch (e) {
      add('cert', false, `error parseando cert: ${e.message}`);
    }
  } catch (e) {
    add('files', false, `error leyendo archivos: ${e.message}`);
  }

  report.ok = report.checks.every((c) => c.ok);
  return report;
}

function loadLibs() {
  if (libsLoaded) return;
  // Workaround TLS obligatorio: los servidores de ARCA usan claves DH pequeñas que
  // Node >= 17 (OpenSSL 3) rechaza. Se parchea `request.post` antes de requerir afip-apis.
  const request = require('request');
  const origPost = request.post.bind(request);
  request.post = function (options, callback) {
    if (options && typeof options === 'object' && !options.ciphers) {
      options.ciphers = 'DEFAULT:@SECLEVEL=0';
    }
    return origPost(options, callback);
  };

  const apis = require('afip-apis');
  wsfev1 = new apis.Wsfev1(process.env.AFIP_PRODUCTION === 'true' ? apis.Wsfev1.produccionWSDL : apis.Wsfev1.testWSDL);
  LoginTicket = apis.LoginTicket;
  libsLoaded = true;
}

function isConfigured() {
  const pathsOk = Boolean(process.env.AFIP_CERT_PATH && process.env.AFIP_KEY_PATH);
  const contentOk = Boolean(process.env.AFIP_CERT_CONTENT && process.env.AFIP_KEY_CONTENT);
  return Boolean(process.env.AFIP_CUIT && (pathsOk || contentOk));
}

function wsaaUrl() {
  return process.env.AFIP_PRODUCTION === 'true'
    ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms?WSDL'
    : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?WSDL';
}

function fmtYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function getAuth() {
  loadLibs();
  if (cachedAuth && Date.now() < cachedAuthExpiresAt) return cachedAuth;

  try {
    const ticket = await new LoginTicket().wsaaLogin(
      wsfev1.serviceId,
      wsaaUrl(),
      path.resolve(certPaths().certPath),
      path.resolve(certPaths().keyPath)
    );

    const expiresAt = new Date(ticket.header.expirationTime).getTime() - 60 * 1000;
    cachedAuth = {
      Token: ticket.credentials.token,
      Sign: ticket.credentials.sign,
      Cuit: Number(process.env.AFIP_CUIT),
    };
    cachedAuthExpiresAt = expiresAt;
    console.log(`[ARCA] Login WSAA OK. Vence: ${ticket.header.expirationTime}`);
    return cachedAuth;
  } catch (err) {
    console.error('[ARCA] Error en login WSAA:', err.message);
    throw err;
  }
}

/**
 * Emite una Factura C (CbteTipo 11), Concepto 2 (servicios), IVA no discriminado.
 *
 * @param {object} opts
 * @param {number} opts.docTipo      80=CUIT, 86=CUIL, 96=DNI
 * @param {number} opts.docNro       Número de documento del comprador
 * @param {number} opts.monto        Importe total en ARS
 * @param {string} opts.periodoDesde YYYYMMDD inicio del período facturado
 * @param {string} opts.periodoHasta YYYYMMDD fin del período facturado
 * @returns {Promise<{cae: string, caeFchVto: string, cbteNro: number, ptoVta: number, cbteTipo: number, fecha: string, resultado: string}>}
 */
async function emitirFacturaC({ docTipo, docNro, monto, periodoDesde, periodoHasta }) {
  if (!isConfigured()) {
    throw new Error('ARCA no configurado: faltan AFIP_CUIT / AFIP_CERT_PATH / AFIP_KEY_PATH');
  }
  loadLibs();

  const auth = await getAuth();
  const ptoVta = Number(process.env.AFIP_PTO_VTA || 1);
  const cbteTipo = 11; // Factura C
  const montoNum = Math.round(Number(monto) * 100) / 100;

  console.log(`[ARCA] Emitiendo Factura C - docTipo=${docTipo} docNro=${docNro} monto=${montoNum} periodo=${periodoDesde}->${periodoHasta}`);

  const ultimo = await wsfev1.FECompUltimoAutorizado({ Auth: auth, PtoVta: ptoVta, CbteTipo: cbteTipo });
  const cbteNro = Number(ultimo.FECompUltimoAutorizadoResult.CbteNro) + 1;
  console.log(`[ARCA] Último autorizado PtoVta ${ptoVta}: N° ${cbteNro - 1}. Emitiendo N° ${cbteNro}`);

  const det = {
    Concepto: 2, // Servicios
    DocTipo: Number(docTipo),
    DocNro: Number(docNro),
    CbteDesde: cbteNro,
    CbteHasta: cbteNro,
    CbteFch: fmtYMD(new Date()),
    ImpTotal: montoNum,
    ImpTotConc: 0,
    ImpNeto: montoNum, // IVA no discriminado: neto = total
    ImpOpEx: 0,
    ImpTrib: 0,
    ImpIVA: 0,
    FchServDesde: periodoDesde,
    FchServHasta: periodoHasta,
    FchVtoPago: '',
    MonId: 'PES',
    MonCotiz: 1,
  };

  const feCAEReq = {
    FeCabReq: { CantReg: 1, PtoVta: ptoVta, CbteTipo: cbteTipo },
    FeDetReq: { FECAEDetRequest: [det] },
  };

  console.log(`[ARCA] Enviando FECAESolicitar - PtoVta ${ptoVta} N° ${cbteNro} - $${montoNum}`);
  const res = await wsfev1.FECAESolicitar({ Auth: auth, FeCAEReq: feCAEReq });
  const result = res.FECAESolicitarResult;

  if (result.Errors && result.Errors.Err && result.Errors.Err.length) {
    const msgs = result.Errors.Err.map(e => `${e.Code}: ${e.Msg}`).join(' | ');
    console.error(`[ARCA] Respuesta FECAESolicitar con errores: ${msgs}`);
    throw new Error(`ARCA rechazó la Factura C: ${msgs}`);
  }

  const resp = result.FeDetResp.FECAEDetResponse[0];
  if (!resp || resp.Resultado !== 'A') {
    const obs = (resp && resp.Observaciones && resp.Observaciones.Obs || [])
      .map(o => `${o.Code}: ${o.Msg}`).join(' | ');
    console.error(`[ARCA] Resultado ${resp ? resp.Resultado : 'sin detalle'}${obs ? ' - ' + obs : ''}`);
    throw new Error(`ARCA Resultado ${resp ? resp.Resultado : 'sin detalle'}${obs ? ' - ' + obs : ''}`);
  }

  console.log(`[ARCA] Factura C OK: N° ${resp.CbteDesde} CAE ${resp.CAE} vto ${resp.CAEFchVto}`);
  return {
    cae: resp.CAE,
    caeFchVto: resp.CAEFchVto,
    cbteNro: Number(resp.CbteDesde),
    ptoVta: result.FeCabResp.PtoVta,
    cbteTipo,
    fecha: fmtYMD(new Date()),
    resultado: resp.Resultado,
  };
}

module.exports = { emitirFacturaC, isConfigured, getAuth, fmtYMD, diagnoseCerts };
