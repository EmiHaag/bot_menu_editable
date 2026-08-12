require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.NEON_DATABASE_URL);

(async () => {
  try {
    const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`;
    console.log('TABLES:', JSON.stringify(tables));
    for (const t of tables) {
      const cols = await sql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${t.table_name}
        ORDER BY ordinal_position
      `;
      console.log(`\nTABLE ${t.table_name}:`);
      console.log(JSON.stringify(cols, null, 1));
    }
  } catch (e) {
    console.error('ERR', e.message);
  }
})();
