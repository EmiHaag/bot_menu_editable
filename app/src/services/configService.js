const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');

const sql = process.env.NEON_DATABASE_URL ? neon(process.env.NEON_DATABASE_URL) : null;

const CONFIG_FILE = path.join(__dirname, '..', '..', '..', 'config.json');

const CACHE_TTL = 5000;
let cache = null;
let cacheTime = 0;

const ENV_MAP = {
    precio_estandar: 'PRECIO_ESTANDAR'
};

function parseValue(s) {
    if (s === null || s === undefined || s === '') return undefined;
    try { return JSON.parse(s); } catch { return s; }
}

async function ensureTable() {
    if (!sql) {
        console.error('[ConfigService] NEON_DATABASE_URL not set, config service disabled');
        return;
    }
    try {
        await sql`
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            )
        `;
        console.log('[ConfigService] Table config ready');
    } catch (err) {
        console.error('[ConfigService] Error ensuring table:', err.message);
    }
}

async function getAll() {
    if (!sql) return null;
    if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
    try {
        const rows = await sql`SELECT key, value FROM config`;
        const obj = {};
        for (const r of rows) obj[r.key] = parseValue(r.value);
        cache = obj;
        cacheTime = Date.now();
        return obj;
    } catch (err) {
        console.error('[ConfigService] Error reading config:', err.message);
        return null;
    }
}

async function setMany(data) {
    if (!sql) return;
    if (!data || typeof data !== 'object') return;
    try {
        for (const [k, v] of Object.entries(data)) {
            if (v === undefined || v === null) continue;
            const value = typeof v === 'string' ? v : JSON.stringify(v);
            await sql`
                INSERT INTO config (key, value) VALUES (${k}, ${value})
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            `;
        }
        cache = null;
    } catch (err) {
        console.error('[ConfigService] Error writing config:', err.message);
    }
}

function readFromFile() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function writeToFile(data) {
    try {
        const current = readFromFile();
        Object.assign(current, data);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
    } catch (err) {
        console.error('[ConfigService] Error writing config.json:', err.message);
    }
}

async function seed() {
    if (!sql) return;
    try {
        const dbConfig = (await getAll()) || {};
        const fileConfig = readFromFile();
        const merged = {};

        for (const [k, v] of Object.entries(fileConfig)) {
            if (v !== undefined && v !== null) merged[k] = v;
        }
        for (const [k, envVar] of Object.entries(ENV_MAP)) {
            if (!(k in merged) && process.env[envVar] != null) merged[k] = process.env[envVar];
        }

        const toWrite = {};
        for (const [k, v] of Object.entries(merged)) {
            if (!(k in dbConfig)) toWrite[k] = v;
        }
        if (Object.keys(toWrite).length > 0) {
            await setMany(toWrite);
            console.log('[ConfigService] Seeded config into DB:', Object.keys(toWrite).join(', '));
        }
    } catch (err) {
        console.error('[ConfigService] Error seeding config:', err.message);
    }
}

module.exports = {
    ensureTable,
    getAll,
    setMany,
    seed,
    readFromFile,
    writeToFile
};