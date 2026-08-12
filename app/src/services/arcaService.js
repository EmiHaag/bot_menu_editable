require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP_DIR = os.tmpdir();

let wsfev1 = null;
let Wsfev1Class = null;
let LoginTicket = null;
let libsLoaded = false;

// Ticket WSAA cacheado (~12h de validez). Se renueva recién 60s antes de expirar.
let cachedAuth = null;
let cachedAuthExpiresAt = 0;

// En Koyeb no hay archivos: el cert/key llegan por env var (AFIP_CERT_CONTENT /
// AFIP_KEY_CONTENT). Se escriben a /tmp al iniciar y se usan como paths.
// Si el valor viene en AFIP_CERT_PATH/AFIP_KEY_PATH pero es un PEM (no una ruta),
// se auto-detecta y también se materializa a /tmp.
let certsMaterialized = false;

function isPem(value) {
  return Boolean(value) && String(value).includes('-----BEGIN');
}

function materializeCerts() {
  if (certsMaterialized) return;
  const certValue = process.env.AFIP_CERT_CONTENT || process.env.AFIP_CERT_PATH;
  const keyValue = process.env.AFIP_KEY_CONTENT || process.env.AFIP_KEY_PATH;
  const write = (name, value) => {
    if (!value) return;
    let content = String(value).trim();
    if (!content.includes('-----BEGIN')) {
      try { content = Buffer.from(content, 'base64').toString('utf8'); } catch (e) { /* keep raw */ }
    }
    if (!content.endsWith('\n')) content += '\n';
    const dest = path.join(TMP_DIR, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, { mode: 0o600 });
  };
  write('afip_cert.pem', certValue);
  write('afip_key.pem', keyValue);
  certsMaterialized = true;
}

function certPaths() {
  const contentMode = Boolean(process.env.AFIP_CERT_CONTENT || process.env.AFIP_KEY_CONTENT);
  const pemInPath = isPem(process.env.AFIP_CERT_PATH) || isPem(process.env.AFIP_KEY_PATH);
  if (contentMode || pemInPath) materializeCerts();
  const certIsPem = isPem(process.env.AFIP_CERT_CONTENT) || isPem(process.env.AFIP_CERT_PATH);
  const keyIsPem = isPem(process.env.AFIP_KEY_CONTENT) || isPem(process.env.AFIP_KEY_PATH);
  if (certIsPem || keyIsPem) {
    return {
      certPath: certIsPem ? path.join(TMP_DIR, 'afip_cert.pem') : process.env.AFIP_CERT_PATH,
      keyPath: keyIsPem ? path.join(TMP_DIR, 'afip_key.pem') : process.env.AFIP_KEY_PATH,
    };
  }
  return { certPath: process.env.AFIP_CERT_PATH, keyPath: process.env.AFIP_KEY_PATH };
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
  Wsfev1Class = apis.Wsfev1;
  wsfev1 = new Wsfev1Class(process.env.AFIP_PRODUCTION === 'true' ? Wsfev1Class.produccionWSDL : Wsfev1Class.testWSDL);
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
      Wsfev1Class.serviceId,
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
    if (err && err.extra) console.error('[ARCA] Detalle WSAA:', JSON.stringify(err.extra, null, 2));
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
async function emitirFacturaC(opts) {
  return emitirComprobante({ cbteTipo: 11, ...opts });
}

/**
 * Emite una Nota de Crédito C (CbteTipo 13) que anula una Factura C ya emitida.
 *
 * @param {object} opts
 * @param {number} opts.docTipo      96=DNI, 80=CUIT, 86=CUIL
 * @param {number} opts.docNro       Número de documento del comprador
 * @param {number} opts.monto        Importe a anular (igual al de la factura original)
 * @param {string} opts.periodoDesde YYYYMMDD período de la factura original
 * @param {string} opts.periodoHasta YYYYMMDD período de la factura original
 * @param {object} opts.facturaOriginal {ptoVta, cbteTipo, cbteNro} del comprobante a anular
 */
async function emitirNotaCredito(opts) {
  const { facturaOriginal } = opts;
  if (!facturaOriginal || !facturaOriginal.cbteNro) {
    throw new Error('Nota de Crédito requiere facturaOriginal {ptoVta, cbteTipo, cbteNro}');
  }
  return emitirComprobante({
    cbteTipo: 13,
    cbtesAsoc: [
      {
        PtoVta: facturaOriginal.ptoVta,
        CbteTipo: facturaOriginal.cbteTipo,
        CbteNro: facturaOriginal.cbteNro,
      },
    ],
    ...opts,
  });
}

async function emitirComprobante({ docTipo, docNro, monto, periodoDesde, periodoHasta, cbteTipo, cbtesAsoc = [] }) {
  if (!isConfigured()) {
    throw new Error('ARCA no configurado: faltan AFIP_CUIT / AFIP_CERT_PATH / AFIP_KEY_PATH');
  }
  loadLibs();

  const auth = await getAuth();
  const ptoVta = Number(process.env.AFIP_PTO_VTA || 1);
  const esNC = cbteTipo === 13;
  const montoNum = Math.round(Number(monto) * 100) / 100;

  console.log(`[ARCA] Emitiendo ${esNC ? 'Nota de Crédito C' : `Factura C (Tipo ${cbteTipo})`} - docTipo=${docTipo} docNro=${docNro} monto=${montoNum} periodo=${periodoDesde}->${periodoHasta}`);

  const ultimo = await wsfev1.FECompUltimoAutorizado({ Auth: auth, PtoVta: ptoVta, CbteTipo: cbteTipo });
  const cbteNro = Number(ultimo.FECompUltimoAutorizadoResult.CbteNro) + 1;
  console.log(`[ARCA] Último autorizado PtoVta ${ptoVta} Tipo ${cbteTipo}: N° ${cbteNro - 1}. Emitiendo N° ${cbteNro}`);

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
    FchVtoPago: fmtYMD(new Date()),
    MonId: 'PES',
    MonCotiz: 1,
  };
  if (esNC) {
    det.CbtesAsoc = cbtesAsoc.map((a) => ({
      CbteAsoc: {
        Tipo: a.cbteTipo ?? a.CbteTipo,
        PtoVta: a.ptoVta ?? a.PtoVta,
        Nro: a.cbteNro ?? a.CbteNro,
      },
    }));
  }

  const feCAEReq = {
    FeCabReq: { CantReg: 1, PtoVta: ptoVta, CbteTipo: cbteTipo },
    FeDetReq: { FECAEDetRequest: [det] },
  };

  console.log(`[ARCA] Enviando FECAESolicitar - PtoVta ${ptoVta} Tipo ${cbteTipo} N° ${cbteNro} - $${montoNum}`);
  const res = await wsfev1.FECAESolicitar({ Auth: auth, FeCAEReq: feCAEReq });
  console.log('[ARCA] Respuesta FECAESolicitar:', JSON.stringify(res, null, 2));
  const result = res.FECAESolicitarResult;

  // afip-apis parsea con explicitArray:false → un solo elemento puede venir como objeto
  const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

  const errs = toArray(result.Errors && result.Errors.Err);
  if (errs.length) {
    const msgs = errs.map((e) => `${e.Code}: ${e.Msg}`).join(' | ');
    console.error(`[ARCA] Respuesta FECAESolicitar con errores: ${msgs}`);
    throw new Error(`ARCA rechazó el comprobante: ${msgs}`);
  }

  const dets = toArray(result.FeDetResp && result.FeDetResp.FECAEDetResponse);
  const resp = dets[0];
  if (!resp || resp.Resultado !== 'A') {
    const obs = toArray(resp && resp.Observaciones && resp.Observaciones.Obs)
      .map((o) => `${o.Code}: ${o.Msg}`).join(' | ');
    console.error(`[ARCA] Resultado ${resp ? resp.Resultado : 'sin detalle'}${obs ? ' - ' + obs : ''}`);
    throw new Error(`ARCA Resultado ${resp ? resp.Resultado : 'sin detalle'}${obs ? ' - ' + obs : ''}`);
  }

  console.log(`[ARCA] ${esNC ? 'Nota de Crédito' : 'Factura C'} OK: N° ${resp.CbteDesde} CAE ${resp.CAE} vto ${resp.CAEFchVto}`);
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

module.exports = { emitirFacturaC, emitirNotaCredito, isConfigured, getAuth, fmtYMD };
