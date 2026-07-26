const { neon } = require('@neondatabase/serverless');

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

async function ensureTable() {
    if (!sql) return;
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS terms_approvals (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(100) NOT NULL,
                username VARCHAR(100),
                terms_version VARCHAR(20) NOT NULL DEFAULT 'v1.1',
                approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                ip_address VARCHAR(45),
                user_agent TEXT,
                UNIQUE(user_id, terms_version)
            );
        `;
        console.log('[TermsService] Table terms_approvals ready');
    } catch (err) {
        console.error('[TermsService] Error ensuring table:', err.message);
    }
}

async function hasApproved(userId, version = 'v1.1') {
    if (!sql || !userId) return false;
    try {
        const rows = await sql`
            SELECT 1 FROM terms_approvals
            WHERE user_id = ${userId} AND terms_version = ${version}
            LIMIT 1
        `;
        return rows.length > 0;
    } catch (err) {
        console.error('[TermsService] Error checking approval:', err.message);
        return false;
    }
}

async function approve(userId, username, version = 'v1.1', ipAddress = null, userAgent = null) {
    if (!sql || !userId) return false;
    try {
        await sql`
            INSERT INTO terms_approvals (user_id, username, terms_version, ip_address, user_agent)
            VALUES (${userId}, ${username || ''}, ${version}, ${ipAddress || ''}, ${userAgent || ''})
            ON CONFLICT (user_id, terms_version) DO UPDATE
            SET approved_at = NOW(), ip_address = ${ipAddress || ''}, user_agent = ${userAgent || ''}
        `;
        console.log(`[TermsService] User ${userId} approved terms ${version}`);
        return true;
    } catch (err) {
        console.error('[TermsService] Error saving approval:', err.message);
        return false;
    }
}

module.exports = { ensureTable, hasApproved, approve };
