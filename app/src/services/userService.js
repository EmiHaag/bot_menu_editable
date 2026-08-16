const { neon } = require('@neondatabase/serverless');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 600 });

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

function mapRow(row) {
    return {
        idCliente: row.id_cliente,
        nombreCliente: row.nombre_cliente,
        activo: row.activo,
        user: row.username,
        password: row.password,
        fechaSuscripcion: row.fecha_suscripcion,
        spreadsheetId: row.spreadsheet_id,
        email: row.email || '',
        fechaTerminos: row.fecha_terminos || '',
        fechaPago: row.fecha_pago || '',
        fechaVencimiento: row.fecha_vencimiento || '',
        online24_7: row.online_24_7 !== false,
        horarios: row.horarios || ''
    };
}

class UserService {
    constructor() {
        this.migrated = false;
    }

    async ensureTable() {
        if (!sql) {
            console.error('[UserService] NEON_DATABASE_URL not set, users service disabled');
            return;
        }
        try {
            await sql`
                CREATE TABLE IF NOT EXISTS users (
                    id_cliente VARCHAR(100) PRIMARY KEY,
                    nombre_cliente TEXT NOT NULL DEFAULT '',
                    activo BOOLEAN NOT NULL DEFAULT true,
                    username VARCHAR(100) NOT NULL,
                    password TEXT NOT NULL,
                    fecha_suscripcion TEXT DEFAULT '',
                    spreadsheet_id TEXT DEFAULT '',
                    email TEXT DEFAULT '',
                    fecha_terminos TEXT DEFAULT '',
                    fecha_pago TEXT DEFAULT '',
                    fecha_vencimiento TEXT DEFAULT '',
                    online_24_7 BOOLEAN NOT NULL DEFAULT true,
                    horarios TEXT DEFAULT ''
                )
            `;
            await sql`
                ALTER TABLE users ADD COLUMN IF NOT EXISTS online_24_7 BOOLEAN NOT NULL DEFAULT true
            `;
            await sql`
                ALTER TABLE users ADD COLUMN IF NOT EXISTS horarios TEXT DEFAULT ''
            `;
            await sql`
                CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (LOWER(email)) WHERE email <> ''
            `;
            console.log('[UserService] Table users ready');
        } catch (err) {
            console.error('[UserService] Error ensuring table:', err.message);
        }
    }

    async migrateFromSheets() {
        if (!sql || this.migrated) return;

        try {
            const existing = await sql`SELECT COUNT(*) as count FROM users`;
            if (Number(existing[0].count) > 0) {
                console.log(`[UserService] Neon already has ${existing[0].count} users, skipping migration`);
                this.migrated = true;
                return;
            }

            console.log('[UserService] Neon is empty, migrating from Google Sheets...');
            const { google } = require('googleapis');
            const GoogleAuthBase = require('./googleAuthBase');
            const auth = new GoogleAuthBase();
            const sheets = google.sheets({ version: 'v4', auth: auth.getAuthClient() });

            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: 'Usuarios!A2:I',
            });

            const rows = response.data.values || [];
            let migrated = 0;

            for (const row of rows) {
                if (row[0] && row[0].trim() !== '') {
                    try {
                        await sql`
                            INSERT INTO users (id_cliente, nombre_cliente, activo, username, password, fecha_suscripcion, spreadsheet_id, email, fecha_terminos)
                            VALUES (${row[0].trim()}, ${row[1] || ''}, ${String(row[2]).toUpperCase() === 'TRUE'}, ${row[3] || ''}, ${row[4] || ''}, ${row[5] || ''}, ${row[6] || process.env.SPREADSHEET_ID}, ${row[7] || ''}, ${row[8] || ''})
                            ON CONFLICT (id_cliente) DO NOTHING
                        `;
                        migrated++;
                    } catch (e) {
                        console.error(`[UserService] Error migrating user ${row[0]}:`, e.message);
                    }
                }
            }

            console.log(`[UserService] Migrated ${migrated} users from Sheets to Neon`);
            this.migrated = true;
        } catch (err) {
            console.error('[UserService] Migration from Sheets failed:', err.message);
        }
    }

    async ensureAdminUser() {
        if (!sql) return;

        try {
            if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
                await sql`
                    INSERT INTO users (id_cliente, nombre_cliente, activo, username, password, fecha_suscripcion, spreadsheet_id, email, fecha_terminos)
                    VALUES (${'admin'}, ${'Administrador'}, ${true}, ${process.env.ADMIN_USER}, ${process.env.ADMIN_PASS}, ${'-'}, ${''}, ${''}, ${''})
                    ON CONFLICT (id_cliente) DO UPDATE SET
                        username = ${process.env.ADMIN_USER},
                        password = ${process.env.ADMIN_PASS}
                `;
                console.log('[UserService] Admin user synced in Neon');
            }
        } catch (err) {
            console.error('[UserService] Error ensuring admin user:', err.message);
        }
    }

    async init() {
        if (!sql) {
            console.error('[UserService] NEON_DATABASE_URL not set, users service disabled');
            return;
        }
        await this.ensureTable();
        await this.migrateFromSheets();
        await this.ensureAdminUser();
        console.log('[UserService] Initialized with Neon PostgreSQL');
    }

    async getUsers() {
        if (!sql) return [];

        const cachedUsers = cache.get('all_users');
        if (cachedUsers) return cachedUsers;

        try {
            const rows = await sql`SELECT * FROM users`;
            const users = rows.map(mapRow);
            cache.set('all_users', users);
            return users;
        } catch (error) {
            console.error('[UserService] Error fetching users:', error.message);
            return [];
        }
    }

    async getUserByUsername(username) {
        if (!sql) return null;

        try {
            const rows = await sql`SELECT * FROM users WHERE username = ${username}`;
            if (rows.length === 0) return null;
            return mapRow(rows[0]);
        } catch (error) {
            console.error('[UserService] Error fetching user by username:', error.message);
            return null;
        }
    }

    async getUserByIdCliente(idCliente) {
        if (!sql || !idCliente) return null;

        try {
            const rows = await sql`SELECT * FROM users WHERE id_cliente = ${idCliente}`;
            if (rows.length === 0) return null;
            return mapRow(rows[0]);
        } catch (error) {
            console.error('[UserService] Error fetching user by idCliente:', error.message);
            return null;
        }
    }

    async getUserByEmail(email) {
        if (!sql || !email) return null;

        try {
            const rows = await sql`SELECT * FROM users WHERE LOWER(email) = LOWER(${email})`;
            if (rows.length === 0) return null;
            return mapRow(rows[0]);
        } catch (error) {
            console.error('[UserService] Error fetching user by email:', error.message);
            return null;
        }
    }

    async updatePassword(idCliente, newPassword) {
        if (!sql) return false;

        try {
            await sql`UPDATE users SET password = ${newPassword} WHERE id_cliente = ${idCliente}`;
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[UserService] Error updating password:', error.message);
            return false;
        }
    }

    async getActiveClients() {
        if (!sql) return [];

        try {
            const rows = await sql`SELECT * FROM users WHERE activo = ${true} AND id_cliente != ${'admin'}`;
            return rows.map(mapRow);
        } catch (error) {
            console.error('[UserService] Error fetching active clients:', error.message);
            return [];
        }
    }

    async addUser(userData) {
        if (!sql) throw new Error('Neon database not configured');

        try {
            const { idCliente, nombreCliente, user, password, spreadsheetId, email } = userData;
            const fecha = new Date().toLocaleDateString();

            await sql`
                INSERT INTO users (id_cliente, nombre_cliente, activo, username, password, fecha_suscripcion, spreadsheet_id, email, fecha_terminos, fecha_pago, fecha_vencimiento, online_24_7, horarios)
                VALUES (${idCliente}, ${nombreCliente || ''}, ${true}, ${user}, ${password}, ${fecha}, ${spreadsheetId || ''}, ${email || ''}, ${''}, ${''}, ${''}, ${true}, ${''})
                ON CONFLICT (id_cliente) DO UPDATE SET
                    nombre_cliente = EXCLUDED.nombre_cliente,
                    activo = EXCLUDED.activo,
                    username = EXCLUDED.username,
                    password = EXCLUDED.password,
                    fecha_suscripcion = EXCLUDED.fecha_suscripcion,
                    spreadsheet_id = EXCLUDED.spreadsheet_id,
                    email = EXCLUDED.email
            `;
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[UserService] Error adding user:', error.message);
            throw error;
        }
    }

    async deleteUser(idCliente) {
        if (!sql) return false;

        try {
            await sql`DELETE FROM users WHERE id_cliente = ${idCliente}`;
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[UserService] Error deleting user:', error.message);
            throw error;
        }
    }

    async updateTermsDate(idCliente) {
        if (!sql) return false;

        try {
            const fecha = new Date().toLocaleDateString();
            await sql`UPDATE users SET fecha_terminos = ${fecha} WHERE id_cliente = ${idCliente}`;
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[UserService] Error updating terms date:', error.message);
            return false;
        }
    }

    async updateSubscriptionDates(idCliente, fechaPago, fechaVencimiento) {
        if (!sql || !idCliente) return false;

        try {
            await sql`
                UPDATE users
                SET fecha_pago = ${fechaPago || ''}, fecha_vencimiento = ${fechaVencimiento || ''}
                WHERE id_cliente = ${idCliente}
            `;
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[UserService] Error updating subscription dates:', error.message);
            return false;
        }
    }

    async updateHorarios(idCliente, online24_7, horarios) {
        if (!sql || !idCliente) return false;

        try {
            await sql`
                UPDATE users
                SET online_24_7 = ${!!online24_7}, horarios = ${horarios || ''}
                WHERE id_cliente = ${idCliente}
            `;
            this.clearCache();
            return true;
        } catch (error) {
            console.error('[UserService] Error updating horarios:', error.message);
            return false;
        }
    }

    clearCache() {
        cache.del('all_users');
    }

    async ensureHeaders() {
        // No longer needed with Neon
    }
}

module.exports = new UserService();
