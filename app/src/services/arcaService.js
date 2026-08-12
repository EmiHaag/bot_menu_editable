require('dotenv').config();
const path = require('path');

let wsfev1 = null;
let LoginTicket = null;
let libsLoaded = false;

// Ticket WSAA cacheado (~12h de validez). Se renueva recién 60s antes de expirar.
let cachedAuth = null;
let cachedAuthExpiresAt = 0;

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
  return Boolean(
    process.env.AFIP_CUIT &&
    process.env.AFIP_CERT_PATH &&
    process.env.AFIP_KEY_PATH
  );
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

  const ticket = await new LoginTicket().wsaaLogin(
    wsfev1.serviceId,
    wsaaUrl(),
    path.resolve(process.env.AFIP_CERT_PATH),
    path.resolve(process.env.AFIP_KEY_PATH)
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

  const ultimo = await wsfev1.FECompUltimoAutorizado({ Auth: auth, PtoVta: ptoVta, CbteTipo: cbteTipo });
  const cbteNro = Number(ultimo.FECompUltimoAutorizadoResult.CbteNro) + 1;

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

  console.log(`[ARCA] Emitiendo Factura C - PtoVta ${ptoVta} N° ${cbteNro} - $${montoNum}`);
  const res = await wsfev1.FECAESolicitar({ Auth: auth, FeCAEReq: feCAEReq });
  const result = res.FECAESolicitarResult;

  if (result.Errors && result.Errors.Err && result.Errors.Err.length) {
    const msgs = result.Errors.Err.map(e => `${e.Code}: ${e.Msg}`).join(' | ');
    throw new Error(`ARCA rechazó la Factura C: ${msgs}`);
  }

  const resp = result.FeDetResp.FECAEDetResponse[0];
  if (!resp || resp.Resultado !== 'A') {
    const obs = (resp && resp.Observaciones && resp.Observaciones.Obs || [])
      .map(o => `${o.Code}: ${o.Msg}`).join(' | ');
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

module.exports = { emitirFacturaC, isConfigured, getAuth, fmtYMD };
