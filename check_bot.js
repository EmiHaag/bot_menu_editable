const { neon } = require('@neondatabase/serverless');
require('dotenv').config({ path: 'C:/Users/emili/coding/bots_koyeb/bot_menu/.env' });
const sql = neon(process.env.DATABASE_URL);
async function check() {
  const rows = await sql`SELECT id_cliente, bot_type, ai_config, menu_config FROM bots WHERE id_cliente = 'test_inmobiliaria'`;
  console.log(JSON.stringify(rows[0], null, 2));
}
check().catch(console.error);