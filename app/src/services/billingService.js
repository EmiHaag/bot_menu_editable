const { neon } = require('@neondatabase/serverless');

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

// Suma meses preservando el día del mes (sin desbordarse en meses cortos)
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Período de gracia (días) antes de suspender el servicio tras el vencimiento
const GRACE_DAYS = 10;

// Clasifica el estado de una suscripción según su fecha de vencimiento y trial.
// Devuelve: 'trial' | 'trial_vencido' | 'activa' | 'gracia' | 'suspendida' | 'sin_suscripcion'
function estadoSuscripcion(fechaVencimiento, trialEndDate) {
  // Si tiene trial activo (sin pago aún)
  if (trialEndDate) {
    const tEnd = new Date(trialEndDate);
    if (!isNaN(tEnd.getTime())) {
      const hoy = new Date();
      const tienePago = fechaVencimiento && !isNaN(new Date(fechaVencimiento).getTime());
      if (!tienePago) {
        // Sin pago: evaluar trial
        if (hoy < tEnd) return 'trial';
        return 'trial_vencido';
      }
    }
  }
  // Lógica original para usuarios con pago
  if (!fechaVencimiento) return 'sin_suscripcion';
  const vto = new Date(fechaVencimiento);
  if (isNaN(vto.getTime())) return 'sin_suscripcion';
  const hoy = new Date();
  const diasVencido = Math.floor((hoy - vto) / (1000 * 60 * 60 * 24));
  if (diasVencido < 0) return 'activa';
  if (diasVencido <= GRACE_DAYS) return 'gracia';
  return 'suspendida';
}

// Fecha en la que se suspende el servicio = vencimiento + período de gracia
function fechaSuspension(fechaVencimiento) {
  if (!fechaVencimiento) return null;
  const vto = new Date(fechaVencimiento);
  if (isNaN(vto.getTime())) return null;
  return addDays(vto, GRACE_DAYS);
}

// Días vencidos (0 = vence hoy, positivo = vencido). -1 si no aplica.
function diasVencido(fechaVencimiento) {
  if (!fechaVencimiento) return -1;
  const vto = new Date(fechaVencimiento);
  if (isNaN(vto.getTime())) return -1;
  return Math.floor((new Date() - vto) / (1000 * 60 * 60 * 24));
}

// Días restantes de trial (positivo = aún tiene trial, 0 o negativo = venció)
function diasRestantesTrial(trialEndDate) {
  if (!trialEndDate) return -1;
  const tEnd = new Date(trialEndDate);
  if (isNaN(tEnd.getTime())) return -1;
  const hoy = new Date();
  return Math.ceil((tEnd - hoy) / (1000 * 60 * 60 * 24));
}

function fmtDate(d) {
  return d.toISOString();
}

// Detecta el tipo de documento a partir del texto ingresado (DNI/CUIT/CUIL)
function detectarDocumento(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 11) {
    const prefix = digits.slice(0, 2);
    if (['20', '23', '24', '27'].includes(prefix)) return { docTipo: 80, docNro: Number(digits) }; // CUIT
    return { docTipo: 86, docNro: Number(digits) }; // CUIL
  }
  if (digits.length >= 7 && digits.length <= 8) return { docTipo: 96, docNro: Number(digits) }; // DNI
  return null;
}

async function ensureTable() {
  if (!sql) {
    console.error('[BillingService] NEON_DATABASE_URL not set, billing service disabled');
    return;
  }
  try {
    await sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS fecha_pago TEXT DEFAULT ''
    `;
    await sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS fecha_vencimiento TEXT DEFAULT ''
    `;
    await sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_start_date TIMESTAMPTZ
    `;
    await sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_end_date TIMESTAMPTZ
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS suscripciones (
        preapproval_id VARCHAR(100) PRIMARY KEY,
        id_cliente VARCHAR(100) NOT NULL,
        nombre_cliente TEXT DEFAULT '',
        email TEXT DEFAULT '',
        doc_tipo INT DEFAULT 96,
        doc_nro BIGINT DEFAULT 0,
        fecha_alta TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        fecha_pago TIMESTAMPTZ,
        fecha_vencimiento TIMESTAMPTZ,
        estado VARCHAR(20) NOT NULL DEFAULT 'activa'
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS facturas (
        id SERIAL PRIMARY KEY,
        payment_id VARCHAR(100) NOT NULL,
        preapproval_id VARCHAR(100) DEFAULT '',
        id_cliente VARCHAR(100) DEFAULT '',
        tipo VARCHAR(20) NOT NULL DEFAULT 'RENOVACION',
        pto_vta INT,
        cbte_tipo INT NOT NULL DEFAULT 11,
        cbte_nro INT,
        cae VARCHAR(20) NOT NULL,
        cae_fch_vto VARCHAR(8) DEFAULT '',
        fecha_cbte VARCHAR(8) DEFAULT '',
        monto NUMERIC(12,2),
        periodo_desde VARCHAR(8) DEFAULT '',
        periodo_hasta VARCHAR(8) DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(payment_id)
      )
    `;
    console.log('[BillingService] Tables suscripciones/facturas ready');
  } catch (err) {
    console.error('[BillingService] Error ensuring tables:', err.message);
  }
}

async function registrarSuscripcion({ preapprovalId, idCliente, nombre, email, docTipo, docNro, fechaPago = null, fechaVencimiento = null }) {
  if (!sql || !preapprovalId || !idCliente) return null;
  try {
    await sql`
      INSERT INTO suscripciones (preapproval_id, id_cliente, nombre_cliente, email, doc_tipo, doc_nro, fecha_pago, fecha_vencimiento, estado)
      VALUES (${preapprovalId}, ${idCliente}, ${nombre || ''}, ${email || ''}, ${docTipo || 96}, ${docNro || 0}, ${fechaPago}, ${fechaVencimiento}, 'activa')
      ON CONFLICT (preapproval_id) DO UPDATE SET
        id_cliente = EXCLUDED.id_cliente,
        nombre_cliente = EXCLUDED.nombre_cliente,
        email = EXCLUDED.email,
        doc_tipo = EXCLUDED.doc_tipo,
        doc_nro = EXCLUDED.doc_nro,
        fecha_pago = COALESCE(EXCLUDED.fecha_pago, suscripciones.fecha_pago),
        fecha_vencimiento = COALESCE(EXCLUDED.fecha_vencimiento, suscripciones.fecha_vencimiento),
        estado = 'activa'
    `;
    return true;
  } catch (err) {
    console.error('[BillingService] Error registrando suscripción:', err.message);
    return null;
  }
}

async function getSuscripcion(preapprovalId) {
  if (!sql || !preapprovalId) return null;
  try {
    const rows = await sql`
      SELECT * FROM suscripciones WHERE preapproval_id = ${preapprovalId}
    `;
    if (rows.length === 0) return null;
    return rows[0];
  } catch (err) {
    console.error('[BillingService] Error obteniendo suscripción:', err.message);
    return null;
  }
}

async function getSuscripcionByIdCliente(idCliente) {
  if (!sql || !idCliente) return null;
  try {
    const rows = await sql`
      SELECT * FROM suscripciones WHERE id_cliente = ${idCliente} ORDER BY fecha_alta DESC LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rows[0];
  } catch (err) {
    console.error('[BillingService] Error obteniendo suscripción por cliente:', err.message);
    return null;
  }
}

// Actualiza fecha de cobro y vencimiento en la suscripción y en la tabla users
async function renovarSuscripcion(preapprovalId, { fechaPago, fechaVencimiento }) {
  if (!sql || !preapprovalId) return false;
  try {
    const sub = await getSuscripcion(preapprovalId);
    const pago = fechaPago ? new Date(fechaPago) : new Date();
    const vto = fechaVencimiento ? new Date(fechaVencimiento) : addMonths(pago, 1);

    const rows = await sql`
      UPDATE suscripciones
      SET fecha_pago = ${pago}, fecha_vencimiento = ${vto}, estado = 'activa'
      WHERE preapproval_id = ${preapprovalId}
      RETURNING id_cliente
    `;
    if (rows.length > 0 && rows[0].id_cliente) {
      await sql`
        UPDATE users
        SET fecha_pago = ${pago.toISOString()}, fecha_vencimiento = ${vto.toISOString()}, activo = true, aviso_suspension = ''
        WHERE id_cliente = ${rows[0].id_cliente}
      `;
    }
    return true;
  } catch (err) {
    console.error('[BillingService] Error renovando suscripción:', err.message);
    return false;
  }
}

// Registro idempotente: payment_id es la clave de negocio. Si ya existe, no inserta.
async function registrarFactura({ paymentId, preapprovalId, idCliente, tipo, factura, monto, periodoDesde, periodoHasta }) {
  if (!sql || !paymentId || !factura) return null;
  try {
    const rows = await sql`
      INSERT INTO facturas (payment_id, preapproval_id, id_cliente, tipo, pto_vta, cbte_tipo, cbte_nro, cae, cae_fch_vto, fecha_cbte, monto, periodo_desde, periodo_hasta)
      VALUES (${paymentId}, ${preapprovalId || ''}, ${idCliente || ''}, ${tipo || 'RENOVACION'}, ${factura.ptoVta || null}, ${factura.cbteTipo || 11}, ${factura.cbteNro || null}, ${factura.cae}, ${factura.caeFchVto || ''}, ${factura.fecha || ''}, ${monto || null}, ${periodoDesde || ''}, ${periodoHasta || ''})
      ON CONFLICT (payment_id) DO NOTHING
      RETURNING *
    `;
    if (rows.length === 0) {
      console.log(`[BillingService] Factura ya existente para payment ${paymentId}`);
      return null;
    }
    return rows[0];
  } catch (err) {
    console.error('[BillingService] Error registrando factura:', err.message);
    return null;
  }
}

async function getFacturaByPaymentId(paymentId) {
  if (!sql || !paymentId) return null;
  try {
    const rows = await sql`
      SELECT * FROM facturas WHERE payment_id = ${paymentId}
    `;
    return rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error('[BillingService] Error buscando factura:', err.message);
    return null;
  }
}

// Historial de pagos/facturas de un cliente, ordenado del más reciente al más antiguo.
async function getFacturasByIdCliente(idCliente) {
  if (!sql || !idCliente) return [];
  try {
    const rows = await sql`
      SELECT * FROM facturas
      WHERE id_cliente = ${idCliente}
      ORDER BY created_at DESC
    `;
    return rows.map(r => ({
      paymentId: r.payment_id,
      preapprovalId: r.preapproval_id,
      idCliente: r.id_cliente,
      tipo: r.tipo,
      ptoVta: r.pto_vta,
      cbteTipo: r.cbte_tipo,
      cbteNro: r.cbte_nro,
      cae: r.cae,
      caeFchVto: r.cae_fch_vto,
      fechaCbte: r.fecha_cbte,
      monto: r.monto,
      periodoDesde: r.periodo_desde,
      periodoHasta: r.periodo_hasta,
      createdAt: r.created_at
    }));
  } catch (err) {
    console.error('[BillingService] Error obteniendo facturas del cliente:', err.message);
    return [];
  }
}

async function deleteSuscripcionByIdCliente(idCliente) {
  if (!sql || !idCliente) return false;
  try {
    await sql`DELETE FROM suscripciones WHERE id_cliente = ${idCliente}`;
    await sql`DELETE FROM facturas WHERE id_cliente = ${idCliente}`;
    console.log(`[BillingService] Suscripciones y facturas eliminadas para ${idCliente}`);
    return true;
  } catch (err) {
    console.error('[BillingService] Error eliminando suscripciones:', err.message);
    return false;
  }
}

module.exports = {
  addMonths,
  addDays,
  GRACE_DAYS,
  estadoSuscripcion,
  fechaSuspension,
  diasVencido,
  diasRestantesTrial,
  fmtDate,
  detectarDocumento,
  ensureTable,
  registrarSuscripcion,
  getSuscripcion,
  getSuscripcionByIdCliente,
  renovarSuscripcion,
  registrarFactura,
  getFacturaByPaymentId,
  getFacturasByIdCliente,
  deleteSuscripcionByIdCliente,
};
