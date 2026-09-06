require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });
const { neon } = require('C:/Users/emili/coding/bots_koyeb/bot_menu/node_modules/@neondatabase/serverless');
const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;
(async () => {
  const rows = await sql`select id_cliente, plan, activo, fecha_suscripcion, fecha_pago, fecha_vencimiento, trial_start_date, trial_end_date from users where id_cliente = 'test_inmobiliaria'`;
  console.log(JSON.stringify(rows, null, 2));
})();
