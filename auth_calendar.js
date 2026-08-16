/**
 * Re-autorización OAuth con los scopes de Sheets + Drive + Calendar.
 * Levanta un mini-servidor en http://localhost:3000 para capturar el código
 * automáticamente (flujo installed/desktop). Requiere que en Google Cloud la
 * URI de redirección autorizada sea http://localhost:3000
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { google } = require('googleapis');

const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/calendar'
];

const REDIRECT = 'http://localhost:3000';
const PORT = 3000;

function getCredentials() {
    if (process.env.OAUTH_CREDENTIALS_CONTENT) {
        return typeof process.env.OAUTH_CREDENTIALS_CONTENT === 'string'
            ? JSON.parse(process.env.OAUTH_CREDENTIALS_CONTENT)
            : process.env.OAUTH_CREDENTIALS_CONTENT;
    }
    const p = path.resolve(process.cwd(), 'oauth_credentials.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p));
    throw new Error('No se encontraron credenciales (OAUTH_CREDENTIALS_CONTENT o oauth_credentials.json)');
}

function loadEnv() {
    const p = path.resolve(process.cwd(), '.env');
    if (!fs.existsSync(p)) return {};
    const out = {};
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

function saveEnv(updates) {
    const p = path.resolve(process.cwd(), '.env');
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const out = [];
    let replaced = new Set();
    for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx === -1) { out.push(line); continue; }
        const k = line.slice(0, idx).trim();
        if (updates[k] !== undefined) {
            out.push(`${k}=${updates[k]}`);
            replaced.add(k);
        } else {
            out.push(line);
        }
    }
    for (const k of Object.keys(updates)) {
        if (!replaced.has(k)) out.push(`${k}=${updates[k]}`);
    }
    fs.writeFileSync(p, out.join('\n') + '\n');
}

function startServer(oAuth2Client, onToken) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://localhost:${PORT}`);
            if (url.pathname === '/') {
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');
                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end(`Error de autorización: ${error}`);
                    reject(new Error(`OAuth error: ${error}`));
                    return;
                }
                if (!code) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h3>Esperando autorización... cerra esta pestaña.</h3>');
                    return;
                }
                try {
                    const { tokens } = await oAuth2Client.getToken(code);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h3>¡Autorizado! Ya podés cerrar esta pestaña y volver a la terminal.</h3>');
                    server.close();
                    onToken(tokens);
                    resolve(tokens);
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Error al obtener token: ' + e.message);
                    reject(e);
                }
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        server.listen(PORT, 'localhost', () => resolve(server));
    });
}

async function main() {
    const env = loadEnv();
    process.env.OAUTH_CREDENTIALS_CONTENT = process.env.OAUTH_CREDENTIALS_CONTENT || env.OAUTH_CREDENTIALS_CONTENT;

    const credentials = getCredentials();
    const config = credentials.installed || credentials.web;
    if (!config) throw new Error('Formato de credenciales OAuth inválido');

    const { client_secret, client_id } = config;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT);

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
        redirect_uri: REDIRECT
    });

    console.log('\nLevantando servidor local en http://localhost:' + PORT + ' ...');
    await startServer(oAuth2Client, (tokens) => {
        fs.writeFileSync(path.resolve(process.cwd(), 'token.json'), JSON.stringify(tokens, null, 2));
        console.log('\nToken guardado en token.json');
        const env2 = loadEnv();
        if (env2.OAUTH_TOKEN_CONTENT !== undefined) {
            saveEnv({ OAUTH_TOKEN_CONTENT: JSON.stringify(tokens) });
            console.log('OAUTH_TOKEN_CONTENT actualizado en .env');
        }
        console.log('\nScopes autorizados:', tokens.scope || SCOPES.join(', '));
        process.exit(0);
    });

    console.log('==========================================================');
    console.log('1) Abrí esta URL en el navegador (con la cuenta de Google del bot):');
    console.log('==========================================================\n');
    console.log(authUrl);
    console.log('\nDespués de aprobar, el código se captura solo. Esperando...\n');
}

main().catch((e) => {
    console.error('\nError:', e.message);
    process.exit(1);
});