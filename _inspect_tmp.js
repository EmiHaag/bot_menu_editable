require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.NEON_DATABASE_URL);

(async () => {
  try {
    const users = await sql`SELECT id_cliente, nombre_cliente, activo, username, email, fecha_pago, fecha_vencimiento FROM users ORDER BY activo DESC, id_cliente`;
    console.log('USERS:');
    for (const u of users) {
      console.log(JSON.stringify(u));
    }
    console.log('---');
    const subs = await sql`SELECT preapproval_id, id_cliente, email, estado, fecha_pago, fecha_vencimiento FROM suscripciones`;
    console.log('SUSCRIPCIONES:', subs.length);
    for (const s of subs) {
      console.log(JSON.stringify(s));
    }
    console.log('---');
    const facs = await sql`SELECT id, payment_id, id_cliente, tipo, cae, cbte_nro FROM facturas`;
    console.log('FACTURAS:', facs.length);
    for (const f of facs) {
      console.log(JSON.stringify(f));
    }
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
})();
